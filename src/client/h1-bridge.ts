/**
 * HTTP/1.1 transport for the streaming `AgentService/Run` RPC, for networks where HTTP/2 does
 * not get through — typically a TLS-intercepting proxy that strips ALPN (e.g. Zscaler).
 *
 * Cursor's own client has the same mode. The server-to-client half is `AgentService/RunSSE`: one
 * long POST whose body names a request id and whose response streams the same Connect frames
 * `Run` does. The client-to-server half is `aiserver.v1.BidiService/BidiAppend`: each client
 * message is a separate unary POST carrying the request id and a sequence number. Only
 * `api2.cursor.sh` serves these over HTTP/1.1; the agent hosts (`agentn.*`) are HTTP/2 only.
 *
 * The handle keeps the `BridgeHandle` contract of h2-session.ts — the same onData frames and
 * onClose exit codes for a clean end (0), a non-2xx status or transport failure (1) — so the
 * retry and recovery logic downstream works unchanged on either transport.
 *
 * `createRunBridge()` picks the transport: `PI_CURSOR_TRANSPORT=http1|http2` forces one; the
 * default starts on HTTP/2 and moves to HTTP/1.1 when HTTP/2 cannot be negotiated before Cursor
 * has said anything, then stays on HTTP/1.1 for a while.
 */
import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { create, toBinary } from "@bufbuild/protobuf";

import { getCursorClientVersion } from "../config/index.js";
import { BidiAppendRequestSchema, BidiRequestIdSchema } from "../proto/agent_pb.js";
import { ConnectFlag } from "../types/enums.js";
import {
  MAX_BRIDGE_MESSAGE_BYTES,
  type BridgeDebugLog,
  type BridgeHandle,
  type SpawnBridgeOptions,
} from "./bridge.js";
import { connectProxiedSocket, resolveCursorProxyUrl } from "./h2-proxy.js";
import { createInProcessBridge } from "./h2-session.js";

/** The host that serves RunSSE and BidiAppend over HTTP/1.1. */
export const CURSOR_HTTP1_BASE_URL = "https://api2.cursor.sh";
export const CURSOR_RUN_PATH = "/agent.v1.AgentService/Run";
const RUN_SSE_PATH = "/agent.v1.AgentService/RunSSE";
const BIDI_APPEND_PATH = "/aiserver.v1.BidiService/BidiAppend";
const MAX_ERROR_BODY_BYTES = 1024 * 1024;
const APPEND_BASE_TIMEOUT_MS = 60_000;
const APPEND_BYTES_PER_SECOND = 128 * 1024;
/** How long `end()` lets queued appends (a cancel action, say) go out before closing. */
const END_DRAIN_MS = 1_000;
/** After HTTP/2 failed to negotiate, how long new runs go straight to HTTP/1.1. */
export const HTTP2_UNAVAILABLE_TTL_MS = 10 * 60_000;

function optionalMs(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  if (value === 0) return 0;
  return Math.floor(value);
}

function connectEndStreamErrorFrame(code: string, message: string): Buffer {
  const payload = Buffer.from(JSON.stringify({ error: { code, message } }), "utf8");
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = ConnectFlag.EndStream;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

function frameMessage(payload: Uint8Array): Buffer {
  const frame = Buffer.alloc(5 + payload.length);
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  return frame;
}

/** The message inside one client Connect frame; BidiAppend carries it unframed. */
function unframe(frame: Uint8Array): Uint8Array | undefined {
  if (frame.length < 5) return undefined;
  const length = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength).readUInt32BE(1);
  if (length !== frame.length - 5 || (frame[0]! & ConnectFlag.EndStream) !== 0) return undefined;
  return frame.subarray(5);
}

interface Http1Run {
  requestId: string;
  nextSeqno: bigint;
  appends: Array<{ seqno: bigint; data: Uint8Array }>;
  appending: boolean;
  /** Set by `end()`: no new writes; queued appends still go out. */
  ended: boolean;
  sse: http.ClientRequest | null;
}

export function createHttp1RunBridge(
  options: SpawnBridgeOptions,
  debugLog: BridgeDebugLog,
  baseUrl: string = CURSOR_HTTP1_BASE_URL,
): BridgeHandle {
  const persistent = options.persistent === true;
  const connectTimeoutMs = optionalMs(options.connectTimeoutMs, 30_000);
  const idleTimeoutMs = optionalMs(options.idleTimeoutMs, 0);
  const origin = new URL(baseUrl);
  const client = origin.protocol === "http:" ? http : https;
  const agent = new client.Agent({ keepAlive: true, maxSockets: 4 });
  const proxy = origin.protocol === "https:" ? resolveCursorProxyUrl() : undefined;

  const cbs = {
    data: null as ((chunk: Buffer) => void) | null,
    close: null as ((code: number) => void) | null,
    streamDone: null as (() => void) | null,
  };
  const queuedData: Buffer[] = [];
  let queuedDataBytes = 0;
  let queuedStreamDone = false;
  let exited = false;
  let exitCode = 1;
  let stderrTail = "";
  let run: Http1Run | null = null;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  let endTimer: ReturnType<typeof setTimeout> | undefined;
  const inFlight = new Set<http.ClientRequest>();

  const appendDiagnostic = (line: string): void => {
    stderrTail = `${stderrTail}\n${line}`.slice(-8_000);
  };

  const clearWatchdog = (): void => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = undefined;
  };
  const armWatchdog = (ms: number): void => {
    clearWatchdog();
    if (!ms || ms <= 0) return;
    watchdogTimer = setTimeout(() => {
      appendDiagnostic("[h1-bridge] connect/idle timeout");
      debugLog("bridge.watchdog_timeout", { transport: "http1" });
      destroyAll();
      finalizeExit(1);
    }, ms);
    watchdogTimer.unref?.();
  };
  const resetIdleWatchdog = (): void => armWatchdog(idleTimeoutMs);

  const destroyAll = (): void => {
    clearWatchdog();
    if (endTimer) clearTimeout(endTimer);
    for (const request of inFlight) request.destroy();
    inFlight.clear();
    run = null;
    agent.destroy();
  };

  const finalizeExit = (code: number): void => {
    if (exited) return;
    exited = true;
    exitCode = code;
    clearWatchdog();
    if (endTimer) clearTimeout(endTimer);
    try {
      cbs.close?.(code);
    } catch (error) {
      debugLog("bridge.close_callback_error", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const deliverData = (payload: Buffer): void => {
    if (!cbs.data) {
      queuedDataBytes += payload.byteLength;
      if (queuedDataBytes > MAX_BRIDGE_MESSAGE_BYTES) {
        debugLog("bridge.prelistener_buffer_limit", { queuedDataBytes });
        destroyAll();
        finalizeExit(1);
        return;
      }
      queuedData.push(payload);
      return;
    }
    try {
      cbs.data(payload);
    } catch (error) {
      debugLog("bridge.data_callback_error", {
        message: error instanceof Error ? error.message : String(error),
      });
      destroyAll();
      finalizeExit(1);
    }
  };

  const deliverStreamDone = (): void => {
    if (!cbs.streamDone) {
      queuedStreamDone = true;
      return;
    }
    try {
      cbs.streamDone();
    } catch (error) {
      debugLog("bridge.stream_done_callback_error", {
        message: error instanceof Error ? error.message : String(error),
      });
      destroyAll();
      finalizeExit(1);
    }
  };

  const commonHeaders = (token: string): Record<string, string> => ({
    ...options.headers,
    authorization: `Bearer ${token}`,
    "connect-protocol-version": "1",
    "x-ghost-mode": "true",
    "x-cursor-client-version": getCursorClientVersion(),
    "x-cursor-client-type": "cli",
  });

  /** One HTTP/1.1 POST, through the configured CONNECT proxy when there is one. */
  const post = (
    path: string,
    headers: Record<string, string>,
    body: Uint8Array,
    onResponse: (response: http.IncomingMessage) => void,
    timeoutMs = 0,
  ): http.ClientRequest => {
    const requestOptions: http.RequestOptions = {
      protocol: origin.protocol,
      hostname: origin.hostname,
      ...(origin.port ? { port: origin.port } : {}),
      path,
      method: "POST",
      headers: { ...headers, "content-length": String(body.byteLength) },
    };
    if (proxy) {
      requestOptions.createConnection = (_opts, oncreate) => {
        connectProxiedSocket(proxy, baseUrl, { alpnProtocols: ["http/1.1"] }).then(
          (socket) => oncreate(null, socket as Duplex),
          (error: Error) => oncreate(error, undefined as unknown as Duplex),
        );
        return undefined;
      };
    } else {
      requestOptions.agent = agent;
    }
    const request = client.request(requestOptions, onResponse);
    inFlight.add(request);
    request.on("close", () => inFlight.delete(request));
    if (timeoutMs > 0) {
      request.setTimeout(timeoutMs, () =>
        request.destroy(new Error(`timed out after ${timeoutMs}ms`)),
      );
    }
    request.end(Buffer.from(body));
    return request;
  };

  const failAppend = (current: Http1Run, message: string): void => {
    if (exited || run !== current) return;
    appendDiagnostic(`[h1-bridge] BidiAppend failed: ${message}`);
    debugLog("bridge.http1_append_failed", { message });
    destroyAll();
    finalizeExit(1);
  };

  const pumpAppends = (current: Http1Run): void => {
    if (exited || run !== current || current.appending) return;
    const append = current.appends.shift();
    if (!append) return;
    current.appending = true;
    const body = toBinary(
      BidiAppendRequestSchema,
      create(BidiAppendRequestSchema, {
        requestId: create(BidiRequestIdSchema, { requestId: current.requestId }),
        appendSeqno: append.seqno,
        dataBinary: append.data,
      }),
    );
    const timeoutMs =
      APPEND_BASE_TIMEOUT_MS + Math.ceil(append.data.byteLength / APPEND_BYTES_PER_SECOND) * 1_000;
    const request = post(
      BIDI_APPEND_PATH,
      {
        ...commonHeaders(currentToken),
        "content-type": "application/proto",
        "x-request-id": randomUUID(),
      },
      body,
      (response) => {
        const status = response.statusCode ?? 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          if (status < 200 || status >= 300) chunks.push(chunk);
        });
        response.on("end", () => {
          current.appending = false;
          if (status < 200 || status >= 300) {
            const detail = Buffer.concat(chunks).toString("utf8").slice(0, 500);
            failAppend(current, `HTTP ${status}${detail ? `: ${detail}` : ""}`);
            return;
          }
          pumpAppends(current);
        });
      },
      timeoutMs,
    );
    request.on("error", (error) => {
      current.appending = false;
      failAppend(current, error.message);
    });
  };

  let currentToken = options.accessToken;

  const startRun = (token: string): void => {
    if (exited) return;
    currentToken = token;
    const current: Http1Run = {
      requestId: randomUUID(),
      nextSeqno: 0n,
      appends: [],
      appending: false,
      ended: false,
      sse: null,
    };
    run = current;
    armWatchdog(connectTimeoutMs);
    const requestIdBody = frameMessage(
      toBinary(BidiRequestIdSchema, create(BidiRequestIdSchema, { requestId: current.requestId })),
    );
    current.sse = post(
      RUN_SSE_PATH,
      {
        ...commonHeaders(token),
        "content-type": "application/connect+proto",
        "x-cursor-streaming": "true",
        "x-request-id": current.requestId,
      },
      requestIdBody,
      (response) => {
        if (run !== current) return;
        resetIdleWatchdog();
        const status = response.statusCode ?? 0;
        const isError = status < 200 || status >= 300;
        const errorChunks: Buffer[] = [];
        let errorBytes = 0;
        response.on("data", (chunk: Buffer) => {
          if (run !== current) return;
          resetIdleWatchdog();
          if (isError) {
            const kept = chunk.subarray(0, Math.max(0, MAX_ERROR_BODY_BYTES - errorBytes));
            errorChunks.push(kept);
            errorBytes += kept.byteLength;
            return;
          }
          deliverData(Buffer.from(chunk));
        });
        response.on("end", () => {
          if (exited || run !== current) return;
          if (isError) {
            const body = Buffer.concat(errorChunks).toString("utf8").trim();
            deliverData(
              connectEndStreamErrorFrame(
                `http_${status}`,
                `Cursor HTTP ${status}: ${body || "HTTP/1.1 RunSSE request failed"}`,
              ),
            );
            destroyAll();
            finalizeExit(1);
            return;
          }
          current.sse = null;
          if (persistent) {
            run = null;
            clearWatchdog();
            deliverStreamDone();
            return;
          }
          destroyAll();
          finalizeExit(0);
        });
        response.on("error", (error: Error) => {
          if (exited || run !== current) return;
          appendDiagnostic(`[h1-bridge] RunSSE response error: ${error.message}`);
          destroyAll();
          finalizeExit(1);
        });
      },
    );
    current.sse.on("error", (error: Error) => {
      if (exited || run !== current) return;
      appendDiagnostic(`[h1-bridge] RunSSE error: ${error.message}`);
      debugLog("bridge.http1_sse_error", { message: error.message });
      destroyAll();
      finalizeExit(1);
    });
  };

  startRun(options.accessToken);

  return {
    proc: {
      kill: () => {
        destroyAll();
        finalizeExit(1);
        return true;
      },
    },
    get alive() {
      return !exited;
    },
    lastStderr() {
      return stderrTail.trim();
    },
    write(data: Uint8Array) {
      const current = run;
      if (exited || !current || current.ended) return;
      const message = unframe(data);
      if (!message) {
        appendDiagnostic("[h1-bridge] dropped a malformed client frame");
        return;
      }
      resetIdleWatchdog();
      current.appends.push({ seqno: current.nextSeqno++, data: message });
      pumpAppends(current);
    },
    openStream(accessToken: string) {
      cbs.data = null;
      cbs.streamDone = null;
      cbs.close = null;
      queuedData.length = 0;
      queuedDataBytes = 0;
      queuedStreamDone = false;
      if (run?.sse) run.sse.destroy();
      startRun(accessToken || options.accessToken);
    },
    end() {
      if (exited) return;
      const current = run;
      if (current) current.ended = true;
      // Let queued appends (typically a cancel action) go out, then close like h2's grace window.
      const started = Date.now();
      const closeWhenDrained = (): void => {
        const drained = !current || (current.appends.length === 0 && !current.appending);
        if (drained || Date.now() - started >= END_DRAIN_MS) {
          destroyAll();
          finalizeExit(0);
          return;
        }
        endTimer = setTimeout(closeWhenDrained, 25);
        endTimer.unref?.();
      };
      closeWhenDrained();
    },
    onData(cb: (chunk: Buffer) => void) {
      cbs.data = cb;
      while (queuedData.length > 0 && !exited) {
        const payload = queuedData.shift()!;
        queuedDataBytes -= payload.byteLength;
        cbs.data(payload);
      }
    },
    onStreamDone(cb: () => void) {
      cbs.streamDone = cb;
      if (queuedStreamDone && !exited) {
        queuedStreamDone = false;
        try {
          cb();
        } catch (error) {
          debugLog("bridge.stream_done_callback_error", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
    onClose(cb: (code: number) => void) {
      if (exited) {
        queueMicrotask(() => {
          try {
            cb(exitCode);
          } catch (error) {
            debugLog("bridge.close_callback_error", {
              message: error instanceof Error ? error.message : String(error),
            });
          }
        });
      } else {
        cbs.close = cb;
      }
    },
  };
}

// ── Transport selection ──

export type RunTransport = "auto" | "http2" | "http1";

/** `PI_CURSOR_TRANSPORT`: `http1` or `http2` forces one; anything else is `auto`. */
export function resolveRunTransport(envValue = process.env.PI_CURSOR_TRANSPORT): RunTransport {
  const raw = envValue?.trim().toLowerCase();
  if (raw === "http1" || raw === "h1" || raw === "http/1.1") return "http1";
  if (raw === "http2" || raw === "h2") return "http2";
  return "auto";
}

/**
 * What an HTTP/2 bridge reports when HTTP/2 itself could not be set up: TLS negotiated no h2
 * (an ALPN-stripping proxy), the peer answered the connection preface as HTTP/1.1 ("Protocol
 * error"), Bun's wording for the same, an ALPN alert, or a reset before TLS completed.
 */
const HTTP2_UNAVAILABLE_PATTERN =
  /could not negotiate HTTP\/2|h2 is not supported|no application protocol|Protocol error|disconnected before secure TLS connection was established/i;

export function isHttp2Unavailable(stderr: string): boolean {
  return HTTP2_UNAVAILABLE_PATTERN.test(stderr);
}

let http2UnavailableUntil = 0;

/** Whether a recent run found HTTP/2 unavailable, so new runs go straight to HTTP/1.1. */
export function http2KnownUnavailable(): boolean {
  return Date.now() < http2UnavailableUntil;
}

export function resetHttp2AvailabilityForTests(): void {
  http2UnavailableUntil = 0;
}

/**
 * Starts on HTTP/2 and replays the run on HTTP/1.1 if HTTP/2 could not be negotiated. The
 * replay is safe only while Cursor has sent nothing back: a connection that never negotiated
 * HTTP/2 never delivered the run request either. Once data arrives, this is a plain HTTP/2
 * bridge.
 */
export function withHttp1Fallback(
  primary: BridgeHandle,
  makeFallback: () => BridgeHandle,
  debugLog: BridgeDebugLog,
): BridgeHandle {
  let fallback: BridgeHandle | undefined;
  let sawData = false;
  let ended = false;
  let replay: Uint8Array[] | null = [];
  let consumerData: ((chunk: Buffer) => void) | undefined;
  let consumerClose: ((code: number) => void) | undefined;
  let consumerStreamDone: (() => void) | undefined;
  const active = (): BridgeHandle => fallback ?? primary;

  const shouldFallBack = (code: number): boolean =>
    code === 1 && !sawData && !ended && replay !== null && isHttp2Unavailable(primary.lastStderr());

  const fallBack = (): void => {
    http2UnavailableUntil = Date.now() + HTTP2_UNAVAILABLE_TTL_MS;
    debugLog("bridge.http1_fallback", { reason: primary.lastStderr().slice(-500) });
    const next = makeFallback();
    fallback = next;
    if (consumerData) next.onData(consumerData);
    if (consumerStreamDone) next.onStreamDone?.(consumerStreamDone);
    if (consumerClose) next.onClose(consumerClose);
    for (const frame of replay ?? []) next.write(frame);
    replay = null;
  };

  return {
    proc: { kill: () => active().proc.kill() },
    get alive() {
      return active().alive;
    },
    lastStderr() {
      return [primary.lastStderr(), fallback?.lastStderr() ?? ""].filter(Boolean).join("\n");
    },
    write(data: Uint8Array) {
      if (!fallback && replay) replay.push(data);
      active().write(data);
    },
    openStream(accessToken: string) {
      consumerData = undefined;
      consumerClose = undefined;
      consumerStreamDone = undefined;
      ended = false;
      active().openStream?.(accessToken);
    },
    end() {
      ended = true;
      active().end();
    },
    onData(cb) {
      consumerData = cb;
      if (fallback) {
        fallback.onData(cb);
        return;
      }
      primary.onData((chunk) => {
        sawData = true;
        replay = null;
        cb(chunk);
      });
    },
    onStreamDone(cb) {
      consumerStreamDone = cb;
      active().onStreamDone?.(cb);
    },
    onClose(cb) {
      consumerClose = cb;
      if (fallback) {
        fallback.onClose(cb);
        return;
      }
      primary.onClose((code) => {
        if (!fallback && shouldFallBack(code)) {
          fallBack();
          return;
        }
        cb(code);
      });
    },
  };
}

/** The bridge for one `AgentService/Run` stream, on the transport `PI_CURSOR_TRANSPORT` asks for. */
export function createRunBridge(
  options: SpawnBridgeOptions,
  debugLog: BridgeDebugLog,
): BridgeHandle {
  const transport = resolveRunTransport();
  const http1 = () => createHttp1RunBridge(options, debugLog);
  if (transport === "http1") {
    debugLog("bridge.transport", { transport: "http1", reason: "PI_CURSOR_TRANSPORT" });
    return http1();
  }
  if (transport === "http2") {
    debugLog("bridge.transport", { transport: "http2", reason: "PI_CURSOR_TRANSPORT" });
    return createInProcessBridge(options, debugLog);
  }
  if (http2KnownUnavailable()) {
    debugLog("bridge.transport", { transport: "http1", reason: "http2_unavailable" });
    return http1();
  }
  debugLog("bridge.transport", { transport: "http2", reason: "auto" });
  return withHttp1Fallback(createInProcessBridge(options, debugLog), http1, debugLog);
}
