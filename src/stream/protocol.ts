/**
 * Protocol-drift helpers: auth error detection, decode error framing, client version.
 */
import type { CursorErrorDetail } from "../client/bridge.js";
import { getCursorClientVersion } from "./config.js";
import { formatDriftSummary, hasStrandingDrift } from "./drift.js";

const AUTH_ERROR_RE =
  /\b(unauthenticated|unauthorized|permission[_ ]?denied|auth(?:entication)?[_ ]?failed|invalid[_ ]?token|expired[_ ]?token|401)\b/i;

const PROTOCOL_ERROR_RE =
  /\b(failed to parse|decode|invalid wire|protocol mismatch|unknown field|premature eof)\b/i;

export function isAuthErrorMessage(message: string): boolean {
  return AUTH_ERROR_RE.test(message);
}

export function isProtocolMismatchMessage(message: string): boolean {
  return PROTOCOL_ERROR_RE.test(message);
}

export function formatProtocolMismatchHint(message: string): string {
  const version = getCursorClientVersion();
  return (
    `${message} ` +
    `[protocol-hint: Cursor wire may have drifted. ` +
    `clientVersion=${version}. Try bumping PI_CURSOR_CLIENT_VERSION or re-run /cursor.doctor.]`
  );
}

/**
 * Appends what actually drifted, when anything did.
 *
 * A turn that fails after we skipped an unrecognized server message would
 * otherwise surface as a bare timeout. Naming the unhandled case turns "it hung"
 * into a reproducible bug report.
 */
export function appendDriftDiagnostic(message: string): string {
  const summary = formatDriftSummary();
  if (!summary) return message;
  const severity = hasStrandingDrift()
    ? "unhandled wire messages — the turn may have been left waiting on one"
    : "unknown wire fields — schema is likely behind Cursor";
  return (
    `${message} ` +
    `[wire-drift: ${severity}. Observed: ${summary}. ` +
    `Regenerate the schema (see proto/README.md) or bump PI_CURSOR_CLIENT_VERSION; ` +
    `/cursor.doctor shows the full list.]`
  );
}

const TRANSIENT_CONNECT_RE =
  /\b(Connect error (?:internal|unavailable|deadline_exceeded)|GOAWAY)\b/i;

/** Cursor's own explanation of a failure as a bracketed note; empty when it sent none. */
export function formatCursorErrorDetail(detail: CursorErrorDetail | undefined): string {
  if (!detail) return "";
  const said = [detail.title, detail.detail].filter(Boolean).join(": ");
  const facts = [
    detail.errorCode,
    detail.providerStatusCode
      ? `the model provider answered Cursor with HTTP ${detail.providerStatusCode}`
      : undefined,
  ]
    .filter(Boolean)
    .join("; ");
  if (!said) return facts ? `[cursor: ${facts}]` : "";
  return `[cursor: ${said}${facts ? ` (${facts})` : ""}]`;
}

/**
 * Adds the hints a failed stream deserves. `message` alone decides which: Cursor's detail text is
 * free-form (a provider status of 401 is not an expired Pi token), so it is appended, never
 * matched.
 */
export function enhanceCursorStreamError(message: string, detail?: CursorErrorDetail): string {
  const explained = formatCursorErrorDetail(detail);
  const stated = explained ? `${message} ${explained}` : message;
  if (isAuthErrorMessage(message)) {
    return (
      `${stated} ` +
      `[auth-hint: token may be expired. Idle stream retries force-refresh credentials; ` +
      `if this persists run /login cursor or check /cursor.doctor tokenSource.]`
    );
  }
  if (isProtocolMismatchMessage(message)) {
    return appendDriftDiagnostic(formatProtocolMismatchHint(stated));
  }
  // Informational unknown fields accumulate on long sessions. Stapling them onto a
  // Connect `internal` abort made a transport retry look like a schema mismatch.
  if (TRANSIENT_CONNECT_RE.test(message)) {
    return stated;
  }
  // Cursor named the cause, so a note that the schema lags behind explains nothing: unknown
  // fields are seen on every session, and stapled onto `resource_exhausted` they made a provider
  // outage read as a wire mismatch. Drift that can strand a turn is still worth reporting.
  if (explained && !hasStrandingDrift()) {
    return stated;
  }
  return appendDriftDiagnostic(stated);
}
