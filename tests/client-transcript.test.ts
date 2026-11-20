import { describe, expect, it } from "vitest";
import {
  clientInFlightTurn,
  liveTranscript,
  recoveredTranscript,
  withSyntheticCurrentTurn,
  withToolResults,
} from "../src/stream/client-transcript.js";
import type { ParsedTurn } from "../src/stream/types.js";

function toolTurn(ids: string[], userText = "do work"): ParsedTurn {
  return {
    userText,
    steps: ids.map((toolCallId) => ({
      kind: "toolCall" as const,
      toolCallId,
      toolName: "bash",
      arguments: {},
    })),
  };
}

describe("client transcript", () => {
  it("live transcript is the wire current turn", () => {
    const completed: ParsedTurn[] = [{ userText: "earlier", steps: [] }];
    const wire = toolTurn(["call-a"]);
    expect(clientInFlightTurn(liveTranscript(completed), wire)).toBe(wire);
  });

  it("recovered transcript prepends Pi's in-flight steps onto the synthetic wire turn", () => {
    const completed: ParsedTurn[] = [{ userText: "earlier", steps: [] }];
    const piInFlight = toolTurn(["call-a", "call-b"]);
    const synthetic = toolTurn(["call-c"], "continue");
    const transcript = recoveredTranscript(completed, piInFlight);
    const merged = clientInFlightTurn(transcript, synthetic);
    expect(merged.steps.map((step) => (step.kind === "toolCall" ? step.toolCallId : ""))).toEqual([
      "call-a",
      "call-b",
      "call-c",
    ]);
  });

  it("keeps the question's images and never takes the synthetic turn's", () => {
    const screenshot = { data: new Uint8Array([1, 2, 3]), mimeType: "image/png" };
    const toolImage = { data: new Uint8Array([9, 9]), mimeType: "image/png" };
    const synthetic: ParsedTurn = { userText: "recovered", steps: [], userImages: [toolImage] };

    const withQuestionImage = recoveredTranscript([], {
      ...toolTurn(["call-a"]),
      userImages: [screenshot],
    });
    expect(clientInFlightTurn(withQuestionImage, synthetic).userImages).toEqual([screenshot]);

    // The synthetic turn carries tool-result images as its own; Pi's turn has none.
    const withoutImage = recoveredTranscript([], toolTurn(["call-a"]));
    expect(clientInFlightTurn(withoutImage, synthetic).userImages).toBeUndefined();
  });

  it("withToolResults gives Pi's in-flight tool calls the results Pi sent back", () => {
    const image = { data: new Uint8Array([1]), mimeType: "image/png" };
    const turn = toolTurn(["call-a", "call-b", "call-c"]);
    const replayed = withToolResults(turn, [
      { toolCallId: "call-a", content: "alpha" },
      { toolCallId: "call-b", content: "boom", isError: true, images: [image] },
    ]);

    expect(replayed.steps).toEqual([
      { ...turn.steps[0], result: { content: "alpha", isError: false } },
      { ...turn.steps[1], result: { content: "boom", isError: true, images: [image] } },
      turn.steps[2],
    ]);
    expect(turn.steps[0], "the parsed turn is left as it was").not.toHaveProperty("result");
  });

  it("withSyntheticCurrentTurn records the pre-recovery turn as Pi's in-flight", () => {
    const completed: ParsedTurn[] = [{ userText: "earlier", steps: [] }];
    const current = toolTurn(["call-a", "call-b"]);
    const recovered = withSyntheticCurrentTurn(liveTranscript(completed), current);
    expect(recovered.kind).toBe("recovered");
    if (recovered.kind === "recovered") {
      expect(recovered.completedTurns).toBe(completed);
      expect(recovered.inFlightTurn).toBe(current);
    }
  });
});
