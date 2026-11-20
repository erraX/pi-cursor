/**
 * Pi's view of the turn in flight, as opposed to the wire history sent upstream.
 *
 * `live` means the wire current turn is Pi's own turn. `recovered` means recovery
 * replaced the wire turn with a synthetic one, so Pi's turn is `inFlightTurn`
 * extended by whatever the synthetic turn produces. Matching recovery against the
 * bridge suffix after any earlier recovery is unrecoverable — the wire turn is
 * only a suffix of Pi's turn, so exact tool-id matching could never succeed again.
 */
import type { ClientTranscript, ParsedTurn, ToolResultInfo } from "./types.js";

export type { ClientTranscript } from "./types.js";

export function liveTranscript(completedTurns: ParsedTurn[]): ClientTranscript {
  return { kind: "live", completedTurns };
}

export function recoveredTranscript(
  completedTurns: ParsedTurn[],
  inFlightTurn: ParsedTurn,
): ClientTranscript {
  return { kind: "recovered", completedTurns, inFlightTurn };
}

/**
 * Pi's in-flight turn as its next request will replay it: the tool calls it made, each with the
 * result Pi sent back. Pi's parsed in-flight turn has the results stripped and listed beside it.
 */
export function withToolResults(turn: ParsedTurn, toolResults: ToolResultInfo[]): ParsedTurn {
  const byId = new Map(toolResults.map((result) => [result.toolCallId, result]));
  return {
    ...turn,
    steps: turn.steps.map((step) => {
      if (step.kind !== "toolCall" || step.result) return step;
      const result = byId.get(step.toolCallId);
      if (!result) return step;
      return {
        ...step,
        result: {
          content: result.content,
          isError: result.isError === true,
          ...(result.images?.length ? { images: result.images } : {}),
        },
      };
    }),
  };
}

/**
 * The turn Pi will report as completed once this stream finishes.
 * After recovery the wire current turn is synthetic; Pi's in-flight turn is the
 * recorded one extended by whatever steps the synthetic turn produced.
 *
 * A checkpoint is committed against this turn, not the wire one. Pi's next request is compared
 * with what the checkpoint was recorded for, and Pi never saw the synthetic turn: its user text
 * is recovered tool output, and its images are the tool results' images, not the question's.
 */
export function clientInFlightTurn(
  transcript: ClientTranscript,
  wireCurrentTurn: ParsedTurn,
): ParsedTurn {
  if (transcript.kind === "live") return wireCurrentTurn;
  const userImages = transcript.inFlightTurn.userImages;
  const recovered: ParsedTurn = {
    userText: transcript.inFlightTurn.userText,
    steps: [...transcript.inFlightTurn.steps, ...wireCurrentTurn.steps],
  };
  if (userImages?.length) recovered.userImages = userImages;
  return recovered;
}

/** Mark that recovery replaced the wire current turn with a synthetic one. */
export function withSyntheticCurrentTurn(
  transcript: ClientTranscript,
  preRecoveryCurrentTurn: ParsedTurn,
): ClientTranscript {
  if (transcript.kind === "recovered") return transcript;
  return recoveredTranscript(transcript.completedTurns, preRecoveryCurrentTurn);
}
