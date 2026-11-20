import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import { beforeEach, describe, expect, it } from "vitest";

import {
  AgentServerMessageSchema,
  ConversationStateStructureSchema,
  InteractionUpdateSchema,
} from "../src/proto/agent_pb.js";
import { getDriftSignals, resetDriftSignalsForTests } from "../src/stream/drift.js";
import { processServerMessage } from "../src/stream/server-messages.js";
import { interactionUpdateProgress } from "../src/stream/tuning.js";
import type { StreamState } from "../src/stream/types.js";

function unknownFieldNos(msg: { $unknown?: readonly { no: number }[] }): number[] {
  return [...new Set((msg.$unknown ?? []).map((field) => field.no))].sort((a, b) => a - b);
}

function emptyState(): StreamState {
  return { toolCallIndex: 0, pendingExecs: [], outputTokens: 0, totalTokens: 0, turnEnded: false };
}

/** Runs one server message through the dispatcher and returns the progress it reports. */
function dispatch(bytes: Uint8Array, onCheckpoint?: (checkpoint: Uint8Array) => void) {
  return processServerMessage(
    fromBinary(AgentServerMessageSchema, bytes),
    new Map(),
    [],
    () => {},
    emptyState(),
    () => {},
    () => {},
    onCheckpoint,
  );
}

/** A server message whose oneof payload is given as raw bytes, the way it comes off the wire. */
function serverMessage(fieldNo: number, payload: Uint8Array): Uint8Array {
  return new BinaryWriter().tag(fieldNo, WireType.LengthDelimited).bytes(payload).finish();
}

// The fields below are written by number and wire type, not through the schema, so the tests
// decode what Cursor sends rather than what this schema would produce.
const RECENT_MESSAGE_ID = "2f6f1f52-7c0b-4a51-9d0f-3b1b0c5d8e11";

/** `conversationCheckpointUpdate` with fields 34, 38, 39 and 46, as seen on 2026-11 checkpoints. */
function checkpointBytes(): Uint8Array {
  return new BinaryWriter()
    .tag(34, WireType.LengthDelimited)
    .string("toolu_ask_1")
    .tag(38, WireType.LengthDelimited)
    .string(RECENT_MESSAGE_ID)
    .tag(39, WireType.Varint)
    .uint32(3)
    .tag(46, WireType.Varint)
    .bool(true)
    .finish();
}

/** `InteractionUpdate` field 27 with `call_count = 12`. */
function toolRequestsListedBytes(): Uint8Array {
  const update = new BinaryWriter().tag(1, WireType.Varint).uint32(12).finish();
  return new BinaryWriter().tag(27, WireType.LengthDelimited).bytes(update).finish();
}

/** `InteractionUpdate` field 21 with a request id and one undeclared nested field (3). */
function feedbackRequestBytes(): Uint8Array {
  const update = new BinaryWriter()
    .tag(1, WireType.LengthDelimited)
    .string("feedback-1")
    .tag(3, WireType.LengthDelimited)
    .bytes(new Uint8Array([0x0a, 0x01, 0x78]))
    .tag(5, WireType.Varint)
    .bool(true)
    .finish();
  return new BinaryWriter().tag(21, WireType.LengthDelimited).bytes(update).finish();
}

beforeEach(() => {
  resetDriftSignalsForTests();
});

describe("fields Cursor sends that the schema used to lack", () => {
  it("decodes the checkpoint fields 34, 38, 39 and 46 by name", () => {
    const checkpoint = fromBinary(ConversationStateStructureSchema, checkpointBytes());

    expect(checkpoint.completedAskQuestionToolCallIds).toEqual(["toolu_ask_1"]);
    expect(checkpoint.recentUserMessageIds).toEqual([RECENT_MESSAGE_ID]);
    expect(checkpoint.recentUserMessageIdsOlderTurnCount).toBe(3);
    expect(checkpoint.writesVoiceCallUtterances).toBe(true);
    expect(unknownFieldNos(checkpoint)).toEqual([]);
  });

  it("sends those checkpoint fields back to Cursor unchanged", () => {
    const original = checkpointBytes();
    const resent = toBinary(
      ConversationStateStructureSchema,
      fromBinary(ConversationStateStructureSchema, original),
    );

    expect(Buffer.from(resent).equals(Buffer.from(original))).toBe(true);
  });

  it("still carries a checkpoint field it does not know", () => {
    // Field 40 (turn_telemetry) is a message this schema leaves undeclared.
    const withTelemetry = new BinaryWriter()
      .tag(38, WireType.LengthDelimited)
      .string(RECENT_MESSAGE_ID)
      .tag(40, WireType.LengthDelimited)
      .bytes(new Uint8Array([0x08, 0x02]))
      .finish();
    const checkpoint = fromBinary(ConversationStateStructureSchema, withTelemetry);

    expect(unknownFieldNos(checkpoint)).toEqual([40]);
    expect(
      Buffer.from(toBinary(ConversationStateStructureSchema, checkpoint)).equals(
        Buffer.from(withTelemetry),
      ),
    ).toBe(true);
  });

  it("takes a checkpoint with those fields without reporting drift", () => {
    let stored: Uint8Array | undefined;
    const progress = dispatch(serverMessage(3, checkpointBytes()), (checkpoint) => {
      stored = checkpoint;
    });

    expect(progress).toBe("work");
    expect(stored && Buffer.from(stored).equals(Buffer.from(checkpointBytes()))).toBe(true);
    expect(getDriftSignals()).toEqual([]);
  });

  it("decodes InteractionUpdate field 27 as the tool requests of a step", () => {
    const update = fromBinary(InteractionUpdateSchema, toolRequestsListedBytes());

    expect(update.message).toEqual({
      case: "toolRequestsListed",
      value: expect.objectContaining({ callCount: 12 }),
    });
    expect(unknownFieldNos(update)).toEqual([]);
  });

  it("counts listed tool requests as model activity, without reporting drift", () => {
    expect(interactionUpdateProgress("toolRequestsListed")).toBe("work");
    expect(dispatch(serverMessage(1, toolRequestsListedBytes()))).toBe("work");
    expect(getDriftSignals()).toEqual([]);
  });

  it("ignores Cursor's feedback form request: no progress and no drift", () => {
    const update = fromBinary(InteractionUpdateSchema, feedbackRequestBytes());
    expect(update.message.case).toBe("feedbackRequest");
    if (update.message.case === "feedbackRequest") {
      expect(update.message.value.requestId).toBe("feedback-1");
      expect(update.message.value.showFormImmediately).toBe(true);
    }

    expect(dispatch(serverMessage(1, feedbackRequestBytes()))).toBe("none");
    expect(getDriftSignals()).toEqual([]);
  });

  it("still reports an interaction update it has no case for", () => {
    const unknownCase = new BinaryWriter()
      .tag(26, WireType.LengthDelimited)
      .bytes(new Uint8Array([0x0a, 0x01, 0x78]))
      .finish();

    expect(dispatch(serverMessage(1, unknownCase))).toBe("none");
    expect(getDriftSignals().map((signal) => `${signal.kind}:${signal.detail}`)).toEqual(
      expect.arrayContaining(["unknown_fields:interactionUpdate.payload#26"]),
    );
  });

  it("builds a checkpoint with the new fields through the schema", () => {
    const checkpoint = create(ConversationStateStructureSchema, {
      recentUserMessageIds: [RECENT_MESSAGE_ID],
      userTimeZone: "Europe/Amsterdam",
    });
    const round = fromBinary(
      ConversationStateStructureSchema,
      toBinary(ConversationStateStructureSchema, checkpoint),
    );

    expect(round.userTimeZone).toBe("Europe/Amsterdam");
    expect(unknownFieldNos(round)).toEqual([]);
  });
});
