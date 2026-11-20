import { describe, expect, it } from "vitest";
import {
  enhanceCursorStreamError,
  isAuthErrorMessage,
  isProtocolMismatchMessage,
} from "../src/stream/protocol.js";
import {
  createConnectFrameParser,
  cursorErrorDetailOf,
  parseConnectEndStream,
} from "../src/client/bridge.js";

describe("protocol helpers", () => {
  it("detects auth and protocol mismatch messages", () => {
    expect(isAuthErrorMessage("Connect error unauthenticated: bad token")).toBe(true);
    expect(isAuthErrorMessage("normal failure")).toBe(false);
    expect(isProtocolMismatchMessage("Failed to parse Connect end stream")).toBe(true);
    expect(
      isProtocolMismatchMessage("Connect error invalid_argument: unknown option '--system-prompt'"),
    ).toBe(false);
  });

  it("enhances auth/protocol errors with hints", () => {
    const auth = enhanceCursorStreamError("unauthenticated");
    expect(auth).toMatch(/auth-hint/);
    expect(auth).toMatch(/force-refresh|\/login cursor/);
    const proto = enhanceCursorStreamError("Failed to parse Connect end stream");
    expect(proto).toMatch(/protocol-hint/);
    expect(proto).toMatch(/PI_CURSOR_CLIENT_VERSION/);
    const invalidArg = enhanceCursorStreamError(
      "Connect error invalid_argument: unknown option '--system-prompt'",
    );
    expect(invalidArg).not.toMatch(/protocol-hint/);
  });

  it("parses connect end-stream errors", () => {
    const err = parseConnectEndStream(
      new TextEncoder().encode(JSON.stringify({ error: { code: "internal", message: "boom" } })),
    );
    expect(err?.message).toMatch(/Connect error internal: boom/);
    expect(cursorErrorDetailOf(err)).toBeUndefined();
  });

  it("keeps Cursor's explanation beside the end-stream error without changing its message", () => {
    // Captured from Cursor on 2026-11-20 for a model id it does not know; `value` shortened.
    const err = parseConnectEndStream(
      new TextEncoder().encode(
        JSON.stringify({
          error: {
            code: "not_found",
            message: "Error",
            details: [
              {
                type: "aiserver.v1.ErrorDetails",
                debug: {
                  error: "ERROR_BAD_MODEL_NAME",
                  details: {
                    title: "AI Model Not Found",
                    detail: 'Model name is not valid: "grok-4.7-500k-max-mode-fast"',
                    isRetryable: false,
                  },
                  isExpected: true,
                },
                value: "CAUSWgoSQUkgTW9kZWwgTm90IEZvdW5k",
              },
            ],
          },
        }),
      ),
    );

    expect(err?.message).toBe("Connect error not_found: Error");
    expect(cursorErrorDetailOf(err)).toEqual({
      errorCode: "ERROR_BAD_MODEL_NAME",
      title: "AI Model Not Found",
      detail: 'Model name is not valid: "grok-4.7-500k-max-mode-fast"',
      providerStatusCode: undefined,
    });
  });

  it.each([
    ["no details", undefined],
    ["details that are not a list", "oops"],
    ["an entry without a debug object", [{ type: "aiserver.v1.ErrorDetails", value: "CAU" }]],
    ["a debug object that says nothing", [{ debug: { isExpected: true } }]],
  ])("finds no explanation in %s", (_label, details) => {
    const err = parseConnectEndStream(
      new TextEncoder().encode(
        JSON.stringify({ error: { code: "internal", message: "boom", details } }),
      ),
    );

    expect(err?.message).toBe("Connect error internal: boom");
    expect(cursorErrorDetailOf(err)).toBeUndefined();
  });

  it("frames connect messages and parses them back", () => {
    const messages: Uint8Array[] = [];
    const ends: Uint8Array[] = [];
    const parse = createConnectFrameParser(
      (m) => messages.push(m),
      (e) => ends.push(e),
    );
    const payload = Buffer.from("hello", "utf8");
    const frame = Buffer.alloc(5 + payload.length);
    frame[0] = 0;
    frame.writeUInt32BE(payload.length, 1);
    payload.copy(frame, 5);
    parse(frame);
    expect(messages).toHaveLength(1);
    expect(Buffer.from(messages[0]!).toString("utf8")).toBe("hello");
    expect(ends).toHaveLength(0);
  });
});
