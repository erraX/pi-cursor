import { fromBinary } from "@bufbuild/protobuf";
import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { AgentServerMessageSchema } from "../src/proto/agent_pb.js";
import {
  applyCursorUsage,
  createCursorAssistantMessage,
  emptyCursorRunUsage,
} from "../src/stream/pi-adapter.js";
import { processServerMessage } from "../src/stream/server-messages.js";
import type { StreamState } from "../src/stream/types.js";

const model = {
  id: "composer-2.5",
  api: "cursor-native",
  provider: "cursor",
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
} as Model<Api>;

function emptyState(overrides: Partial<StreamState> = {}): StreamState {
  return {
    toolCallIndex: 0,
    pendingExecs: [],
    outputTokens: 0,
    totalTokens: 0,
    turnEnded: false,
    ...overrides,
  };
}

/**
 * `AgentServerMessage.interactionUpdate` (1) carrying `turn_ended` (14), written by field number
 * so the test decodes what Cursor sends rather than what this schema would produce. The values
 * are those of a live three-step composer-2.5 run: 3 model calls of ~4.6K prompt tokens each.
 */
function turnEndedFrame(counters: Array<[field: number, value: bigint]>): Uint8Array {
  const turnEnded = new BinaryWriter();
  for (const [field, value] of counters) turnEnded.tag(field, WireType.Varint).int64(value);
  const update = new BinaryWriter()
    .tag(14, WireType.LengthDelimited)
    .bytes(turnEnded.finish())
    .finish();
  return new BinaryWriter().tag(1, WireType.LengthDelimited).bytes(update).finish();
}

const LIVE_COUNTERS: Array<[number, bigint]> = [
  [1, 13_866n], // input_tokens: the whole prompt of every step, cache included
  [2, 294n], // output_tokens
  [3, 13_312n], // cache_read_tokens
  [4, 0n], // cache_write_tokens
  [5, 0n], // reasoning_tokens
  [6, 1_795_179_289_100n], // ended_at_ms
];

function dispatch(bytes: Uint8Array, state: StreamState) {
  return processServerMessage(
    fromBinary(AgentServerMessageSchema, bytes),
    new Map(),
    [],
    () => {},
    state,
    () => {},
    () => {},
  );
}

describe("turnEnded counters", () => {
  it("reads the run's counters, with input net of cache reads and writes", () => {
    const state = emptyState();
    expect(dispatch(turnEndedFrame(LIVE_COUNTERS), state)).toBe("work");
    expect(state.turnEnded).toBe(true);
    expect(state.turnEndedUsage).toEqual({
      input: 554,
      output: 294,
      cacheRead: 13_312,
      cacheWrite: 0,
    });
  });

  it("keeps the estimate when Cursor ends the turn without counters", () => {
    const state = emptyState();
    dispatch(turnEndedFrame([]), state);
    expect(state.turnEnded).toBe(true);
    expect(state.turnEndedUsage).toBeUndefined();
  });
});

describe("applyCursorUsage with turnEnded counters", () => {
  const counters = { input: 554, output: 294, cacheRead: 13_312, cacheWrite: 0 };

  it("bills a run answered in one message with the counters, and keeps the context size", () => {
    const output = createCursorAssistantMessage(model);
    applyCursorUsage(
      output,
      model,
      emptyState({
        outputTokens: 20,
        contextTokens: 4_775,
        turnEndedUsage: counters,
        runUsage: emptyCursorRunUsage(),
      }),
    );
    expect(output.usage).toMatchObject({
      input: 554,
      output: 294,
      cacheRead: 13_312,
      cacheWrite: 0,
      // Compaction reads totalTokens as the size of the context, not as the turn's bill.
      totalTokens: 4_795,
    });
    expect(output.usage.cost.input).toBeCloseTo((554 * 3) / 1_000_000);
    expect(output.usage.cost.output).toBeCloseTo((294 * 15) / 1_000_000);
    expect(output.usage.cost.cacheRead).toBeCloseTo((13_312 * 0.3) / 1_000_000);
  });

  it("settles a run paused for tools so that its messages add up to the counters", () => {
    const runUsage = emptyCursorRunUsage();
    // The two messages Pi received before the run ended, each billed by the estimate.
    const first = createCursorAssistantMessage(model);
    applyCursorUsage(first, model, emptyState({ outputTokens: 107, runUsage }));
    const second = createCursorAssistantMessage(model);
    applyCursorUsage(
      second,
      model,
      emptyState({ outputTokens: 56, contextTokens: 4_650, runUsage }),
    );
    const last = createCursorAssistantMessage(model);
    applyCursorUsage(
      last,
      model,
      emptyState({ outputTokens: 22, contextTokens: 4_775, turnEndedUsage: counters, runUsage }),
    );

    const messages = [first, second, last];
    const sum = (key: "input" | "output" | "cacheRead" | "cacheWrite") =>
      messages.reduce((total, message) => total + message.usage[key], 0);
    expect(sum("output")).toBe(294);
    expect(sum("input") + sum("cacheRead") + sum("cacheWrite")).toBe(13_866);
    // The estimate billed the second step's prompt as fresh input; Cursor says most of it was
    // cached. Without negative buckets that difference stays in input, and the rest of the
    // run's cached prompt lands on the message that ended it.
    expect(last.usage).toMatchObject({ input: 0, output: 131, cacheRead: 9_216, cacheWrite: 0 });
    expect(last.usage.totalTokens).toBe(4_797);
    expect(runUsage, "a settled run starts over").toEqual(emptyCursorRunUsage());
  });

  it("never bills a negative bucket when the estimate overshot the counters", () => {
    const runUsage = { input: 20_000, output: 500, cacheRead: 0, cacheWrite: 0 };
    const output = createCursorAssistantMessage(model);
    applyCursorUsage(output, model, emptyState({ turnEndedUsage: counters, runUsage }));
    expect(output.usage).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(output.usage.cost.total).toBe(0);
  });

  it("records what an unsettled message billed against its run", () => {
    const runUsage = emptyCursorRunUsage();
    const output = createCursorAssistantMessage(model);
    applyCursorUsage(
      output,
      model,
      emptyState({
        outputTokens: 30,
        contextTokens: 1_200,
        previousContextTokens: 1_000,
        runUsage,
      }),
    );
    expect(runUsage).toEqual({ input: 0, output: 30, cacheRead: 1_000, cacheWrite: 200 });
  });
});
