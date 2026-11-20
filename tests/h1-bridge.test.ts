import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BridgeHandle } from "../src/client/bridge.js";
import {
  createHttp1RunBridge,
  http2KnownUnavailable,
  isHttp2Unavailable,
  resetHttp2AvailabilityForTests,
  resolveRunTransport,
  withHttp1Fallback,
} from "../src/client/h1-bridge.js";
import { __testInternals, type H2Session } from "../src/client/h2-session.js";
import { BidiAppendRequestSchema, BidiRequestIdSchema } from "../src/proto/agent_pb.js";

function frame(payload: Uint8Array, flags = 0): Buffer {
  const out = Buffer.alloc(5 + payload.length);
  out[0] = flags;
  out.writeUInt32BE(payload.length, 1);
  out.set(payload, 5);
  return out;
}

interface Received {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** A stand-in for api2.cursor.sh: RunSSE streams what the test pushes, BidiAppend records. */
async function fakeCursor(options: { runStatus?: number; appendStatus?: number } = {}) {
  const received: Received[] = [];
  const sse: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
      if (req.url === "/agent.v1.AgentService/RunSSE") {
        if (options.runStatus && options.runStatus !== 200) {
          res.writeHead(options.runStatus, { "content-type": "text/plain" });
          res.end("unauthenticated");
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        sse.push(res);
        return;
      }
      res.writeHead(options.appendStatus ?? 200, { "content-type": "application/proto" });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    sse,
    runs: () => received.filter((r) => r.path === "/agent.v1.AgentService/RunSSE"),
    appends: () =>
      received
        .filter((r) => r.path === "/aiserver.v1.BidiService/BidiAppend")
        .map((r) => fromBinary(BidiAppendRequestSchema, r.body)),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function bridgeOptions(extra: { persistent?: boolean; headers?: Record<string, string> } = {}) {
  return { accessToken: "token-1", rpcPath: "/agent.v1.AgentService/Run", ...extra };
}

let cursor: Awaited<ReturnType<typeof fakeCursor>> | undefined;
afterEach(async () => {
  await cursor?.close();
  cursor = undefined;
  resetHttp2AvailabilityForTests();
  delete process.env.PI_CURSOR_TRANSPORT;
});

describe("HTTP/1.1 Run bridge", () => {
  it("opens RunSSE for a request id and appends each client frame in order", async () => {
    cursor = await fakeCursor();
    const bridge = createHttp1RunBridge(
      bridgeOptions({ headers: { "x-cursor-agent-allowed-tools": "mcp_tool_call" } }),
      () => {},
      cursor.url,
    );
    const data: Buffer[] = [];
    bridge.onData((chunk) => data.push(chunk));
    bridge.write(frame(Buffer.from("run-request")));
    bridge.write(frame(Buffer.from("heartbeat")));
    await until(() => cursor!.appends().length === 2 && cursor!.sse.length === 1, "run + appends");

    const [run] = cursor.runs();
    expect(run!.headers["content-type"]).toBe("application/connect+proto");
    expect(run!.headers["x-cursor-streaming"]).toBe("true");
    expect(run!.headers.authorization).toBe("Bearer token-1");
    expect(run!.headers["x-cursor-agent-allowed-tools"]).toBe("mcp_tool_call");
    const requestId = fromBinary(BidiRequestIdSchema, run!.body.subarray(5)).requestId;
    expect(requestId).toMatch(/[0-9a-f-]{36}/);

    const appends = cursor.appends();
    expect(appends.map((a) => a.requestId?.requestId)).toEqual([requestId, requestId]);
    expect(appends.map((a) => a.appendSeqno)).toEqual([0n, 1n]);
    expect(appends.map((a) => Buffer.from(a.dataBinary).toString())).toEqual([
      "run-request",
      "heartbeat",
    ]);

    // Server frames arrive unchanged, the same Connect frames HTTP/2 delivers.
    const serverFrame = frame(Buffer.from("server-message"));
    cursor.sse[0]!.write(serverFrame);
    await until(() => data.length > 0, "server data");
    expect(Buffer.concat(data).equals(serverFrame)).toBe(true);

    const closed = vi.fn();
    bridge.onClose(closed);
    cursor.sse[0]!.end();
    await until(() => closed.mock.calls.length > 0, "close");
    expect(closed).toHaveBeenCalledWith(0);
  });

  it("starts a new RunSSE with a new request id when a persistent bridge reopens", async () => {
    cursor = await fakeCursor();
    const bridge = createHttp1RunBridge(bridgeOptions({ persistent: true }), () => {}, cursor.url);
    const done = vi.fn();
    bridge.onStreamDone!(done);
    bridge.write(frame(Buffer.from("first")));
    await until(() => cursor!.sse.length === 1 && cursor!.appends().length === 1, "first run");
    cursor.sse[0]!.end();
    await until(() => done.mock.calls.length === 1, "stream done");
    expect(bridge.alive).toBe(true);

    bridge.openStream!("token-2");
    bridge.write(frame(Buffer.from("second")));
    await until(() => cursor!.sse.length === 2 && cursor!.appends().length === 2, "second run");
    const [first, second] = cursor
      .runs()
      .map((r) => fromBinary(BidiRequestIdSchema, r.body.subarray(5)));
    expect(second!.requestId).not.toBe(first!.requestId);
    expect(cursor.runs()[1]!.headers.authorization).toBe("Bearer token-2");
    const appends = cursor.appends();
    expect(appends[1]!.requestId?.requestId).toBe(second!.requestId);
    expect(appends[1]!.appendSeqno, "each run numbers its appends from 0").toBe(0n);
    bridge.proc.kill();
  });

  it("reports a failed RunSSE as an http_<status> end-stream frame and exit code 1", async () => {
    cursor = await fakeCursor({ runStatus: 401 });
    const bridge = createHttp1RunBridge(bridgeOptions(), () => {}, cursor.url);
    const data: Buffer[] = [];
    const closed = vi.fn();
    bridge.onData((chunk) => data.push(chunk));
    bridge.onClose(closed);
    await until(() => closed.mock.calls.length > 0, "close");
    expect(closed).toHaveBeenCalledWith(1);
    const end = Buffer.concat(data);
    expect(end[0]! & 2).toBe(2);
    expect(JSON.parse(end.subarray(5).toString()).error.code).toBe("http_401");
  });

  it("fails the bridge when an append is refused", async () => {
    cursor = await fakeCursor({ appendStatus: 400 });
    const bridge = createHttp1RunBridge(bridgeOptions(), () => {}, cursor.url);
    const closed = vi.fn();
    bridge.onClose(closed);
    bridge.write(frame(Buffer.from("run-request")));
    await until(() => closed.mock.calls.length > 0, "close");
    expect(closed).toHaveBeenCalledWith(1);
    expect(bridge.lastStderr()).toMatch(/BidiAppend failed: HTTP 400/);
  });

  it("sends queued appends before end() closes the run", async () => {
    cursor = await fakeCursor();
    const bridge = createHttp1RunBridge(bridgeOptions(), () => {}, cursor.url);
    const closed = vi.fn();
    bridge.onClose(closed);
    bridge.write(frame(Buffer.from("cancel-action")));
    bridge.end();
    bridge.write(frame(Buffer.from("too late")));
    await until(() => closed.mock.calls.length > 0, "close");
    expect(closed).toHaveBeenCalledWith(0);
    expect(cursor.appends().map((a) => Buffer.from(a.dataBinary).toString())).toEqual([
      "cancel-action",
    ]);
  });
});

/** A scripted primary bridge standing in for HTTP/2. */
function scriptedBridge(stderr = "") {
  const callbacks: {
    data?: (chunk: Buffer) => void;
    close?: (code: number) => void;
  } = {};
  const written: Uint8Array[] = [];
  const handle: BridgeHandle = {
    proc: { kill: () => true },
    alive: true,
    lastStderr: () => stderr,
    write: (data) => written.push(data),
    end: () => {},
    onData: (cb) => (callbacks.data = cb),
    onClose: (cb) => (callbacks.close = cb),
    openStream: () => {},
    onStreamDone: () => {},
  };
  return { handle, written, callbacks };
}

const NO_H2 =
  "[h2-session] client error: Cursor transport could not negotiate HTTP/2 with https://x: TLS negotiated no protocol via ALPN";

describe("HTTP/1.1 fallback", () => {
  beforeEach(() => resetHttp2AvailabilityForTests());

  it("replays the run on HTTP/1.1 when HTTP/2 could not be negotiated", () => {
    const primary = scriptedBridge(NO_H2);
    const fallback = scriptedBridge();
    const bridge = withHttp1Fallback(
      primary.handle,
      () => fallback.handle,
      () => {},
    );
    const data = vi.fn();
    const closed = vi.fn();
    bridge.onData(data);
    bridge.onClose(closed);
    bridge.write(frame(Buffer.from("run-request")));
    bridge.write(frame(Buffer.from("heartbeat")));

    primary.callbacks.close!(1);
    expect(closed, "the failed HTTP/2 attempt is not reported").not.toHaveBeenCalled();
    expect(fallback.written.map((f) => Buffer.from(f).subarray(5).toString())).toEqual([
      "run-request",
      "heartbeat",
    ]);
    expect(http2KnownUnavailable()).toBe(true);

    // The consumer now hears the fallback.
    fallback.callbacks.data!(Buffer.from("server"));
    fallback.callbacks.close!(0);
    expect(data).toHaveBeenCalledWith(Buffer.from("server"));
    expect(closed).toHaveBeenCalledWith(0);
    bridge.write(frame(Buffer.from("later")));
    expect(fallback.written).toHaveLength(3);
  });

  it("does not replay once Cursor has answered over HTTP/2", () => {
    const primary = scriptedBridge(NO_H2);
    const makeFallback = vi.fn(() => scriptedBridge().handle);
    const bridge = withHttp1Fallback(primary.handle, makeFallback, () => {});
    const closed = vi.fn();
    bridge.onData(() => {});
    bridge.onClose(closed);
    bridge.write(frame(Buffer.from("run-request")));
    primary.callbacks.data!(Buffer.from("server"));
    primary.callbacks.close!(1);
    expect(makeFallback).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledWith(1);
  });

  it("does not replay for a failure that is not about HTTP/2", () => {
    const primary = scriptedBridge("[h2-session] client error: connect ECONNREFUSED");
    const makeFallback = vi.fn(() => scriptedBridge().handle);
    const bridge = withHttp1Fallback(primary.handle, makeFallback, () => {});
    const closed = vi.fn();
    bridge.onClose(closed);
    primary.callbacks.close!(1);
    expect(makeFallback).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledWith(1);
    expect(http2KnownUnavailable()).toBe(false);
  });

  it.each([
    [NO_H2, true],
    ["[h2-session] stream error: Protocol error", true],
    ['Cursor transport could not negotiate HTTP/2 with x: "h2 is not supported"', true],
    ["Client network socket disconnected before secure TLS connection was established", true],
    ["[h2-session] GOAWAY errorCode=0", false],
    ["[h2-session] connect/idle timeout", false],
  ])("classifies %s as HTTP/2 unavailable: %s", (stderr, expected) => {
    expect(isHttp2Unavailable(stderr)).toBe(expected);
  });

  it.each([
    [undefined, "auto"],
    ["http1", "http1"],
    ["HTTP2", "http2"],
    ["bogus", "auto"],
  ])("reads PI_CURSOR_TRANSPORT=%s as %s", (value, expected) => {
    expect(resolveRunTransport(value)).toBe(expected);
  });
});

describe("HTTP/2 session ALPN check", () => {
  function sessionWithSocket(socket: unknown) {
    const session = Object.assign(new EventEmitter(), {
      destroyed: false,
      closed: false,
      socket,
      close: vi.fn(),
      destroy: vi.fn(),
      request: vi.fn(() =>
        Object.assign(new EventEmitter(), {
          destroyed: false,
          closed: false,
          writableLength: 0,
          write: vi.fn(),
          end: vi.fn(),
          destroy: vi.fn(),
          close: vi.fn(),
        }),
      ),
    });
    const bridge = __testInternals.createBridgeHandleForSession(
      session as unknown as H2Session,
      { accessToken: "t", rpcPath: "/agent.v1.AgentService/Run", url: "https://api2.cursor.sh" },
      () => {},
    );
    return { session, bridge };
  }

  it("fails a TLS session that did not negotiate h2, recognizably", () => {
    const { session, bridge } = sessionWithSocket({ encrypted: true, alpnProtocol: false });
    const closed = vi.fn();
    bridge.onClose(closed);
    session.emit("connect");
    expect(closed).toHaveBeenCalledWith(1);
    expect(isHttp2Unavailable(bridge.lastStderr())).toBe(true);
  });

  it("leaves a session that negotiated h2 alone", () => {
    const { session, bridge } = sessionWithSocket({ encrypted: true, alpnProtocol: "h2" });
    session.emit("connect");
    expect(bridge.alive).toBe(true);
  });

  it("leaves a plain-text loopback session alone", () => {
    const { session, bridge } = sessionWithSocket({ encrypted: false });
    session.emit("connect");
    expect(bridge.alive).toBe(true);
  });
});

// Keep the encoder honest about the schema it shares with the server.
describe("BidiAppendRequest", () => {
  it("round-trips the fields the CLI schema lists", () => {
    const bytes = toBinary(
      BidiAppendRequestSchema,
      create(BidiAppendRequestSchema, {
        requestId: create(BidiRequestIdSchema, { requestId: "r" }),
        appendSeqno: 3n,
        dataBinary: new Uint8Array([1, 2]),
      }),
    );
    const decoded = fromBinary(BidiAppendRequestSchema, bytes);
    expect(decoded.requestId?.requestId).toBe("r");
    expect(decoded.appendSeqno).toBe(3n);
    expect([...decoded.dataBinary]).toEqual([1, 2]);
  });
});
