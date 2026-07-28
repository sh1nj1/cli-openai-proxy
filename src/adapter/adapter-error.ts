/**
 * Structured adapter-failure error.
 *
 * A Paperclip adapter run can fail for reasons the OpenAI error contract
 * distinguishes by HTTP status: a Claude Max usage/quota limit (429), an
 * unauthenticated CLI (401), an unknown model (404), or an internal fault (500).
 * The adapter already classifies these into `errorCode`/`errorFamily`; this
 * carries that classification (plus the verbatim CLI message) across the
 * EventEmitter boundary so src/server/routes.ts can answer with the same status
 * code, error `type`, and `Retry-After` header the OpenAI endpoint would.
 */
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

export interface OpenAIErrorShape {
  /** HTTP status to answer with (non-streaming). */
  status: number;
  /** OpenAI error `type` (e.g. "insufficient_quota", "invalid_request_error"). */
  type: string;
  /** OpenAI error `code` (e.g. "insufficient_quota", "model_not_found") or null. */
  code: string | null;
  /** Seconds to advertise via Retry-After, when the adapter reported a reset time. */
  retryAfterSeconds?: number;
  /**
   * Engine whose CLI is unauthenticated, set only for `engine_unauthenticated`.
   * A caller (e.g. Collavre) needs to know WHICH CLI to re-authenticate before it
   * can open the matching /v1/auth flow, and the message alone is not machine-readable.
   */
  engine?: string;
}

export class AdapterRunError extends Error {
  readonly openai: OpenAIErrorShape;

  constructor(message: string, openai: OpenAIErrorShape) {
    super(message);
    this.name = "AdapterRunError";
    this.openai = openai;
  }
}

/**
 * Map an adapter's classified failure to the OpenAI error contract. Prefer the
 * specific `errorCode`; fall back to the broader `errorFamily` (quota/transient)
 * so a run classified only at the family level still surfaces as a 429 rather
 * than a generic 500.
 */
function mapToOpenAI(result: AdapterExecutionResult, engine?: string): OpenAIErrorShape {
  const code = result.errorCode ?? null;
  const family = result.errorFamily ?? null;

  let shape: OpenAIErrorShape;
  if (code === "claude_auth_required") {
    // The CLI itself has no usable credentials — distinct from the proxy rejecting
    // the caller's own API key (`invalid_api_key`). A dedicated code plus `engine`
    // lets a caller react by driving POST /v1/auth/{engine}/sessions instead of
    // re-checking its own key. Still 401: OpenAI answers 401 for auth problems.
    shape = { status: 401, type: "invalid_request_error", code: "engine_unauthenticated", engine };
  } else if (code === "model_not_found") {
    shape = { status: 404, type: "invalid_request_error", code: "model_not_found" };
  } else if (code === "provider_quota" || family === "provider_quota") {
    // Usage/quota cap reached — OpenAI's billing/quota exhaustion is 429 insufficient_quota.
    shape = { status: 429, type: "insufficient_quota", code: "insufficient_quota" };
  } else if (code === "claude_transient_upstream" || family === "transient_upstream") {
    // Upstream rate-limit / overload — OpenAI's retryable 429 rate_limit_exceeded.
    shape = { status: 429, type: "rate_limit_exceeded", code: "rate_limit_exceeded" };
  } else {
    shape = { status: 500, type: "server_error", code: null };
  }

  // Advertise Retry-After (seconds) for a quota/transient reset the adapter dated.
  if (shape.status === 429 && result.retryNotBefore) {
    const resetMs = Date.parse(result.retryNotBefore);
    if (Number.isFinite(resetMs)) {
      shape.retryAfterSeconds = Math.max(0, Math.ceil((resetMs - Date.now()) / 1000));
    }
  }
  return shape;
}

/** Build an AdapterRunError carrying the verbatim message and OpenAI classification. */
export function adapterRunError(
  message: string,
  result: AdapterExecutionResult,
  engine?: string,
): AdapterRunError {
  return new AdapterRunError(message, mapToOpenAI(result, engine));
}

/**
 * Resolve any error thrown/emitted by the runner into the OpenAI envelope
 * routes.ts sends. A plain Error (spawn failure, adapter throw) is an internal
 * 500; an AdapterRunError carries its own classified status/type/code.
 */
export function openaiErrorFromError(error: unknown): { message: string } & OpenAIErrorShape {
  const message = error instanceof Error ? error.message : "Unknown error";
  if (error instanceof AdapterRunError) {
    return { message, ...error.openai };
  }
  return { message, status: 500, type: "server_error", code: null };
}
