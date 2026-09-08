/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for Clawdbot integration
 */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { runnerFactory, PAPERCLIP_MODEL_IDS, UnknownPaperclipModelError, DEFAULT_MODEL } from "../adapter/paperclip-registry.js";
import type { AgentRunner } from "../adapter/agent-runner.js";
import { openaiToCli } from "../adapter/openai-to-cli.js";
import { materializeImages, ImageValidationError } from "../adapter/image-materializer.js";
import { openaiErrorFromError } from "../adapter/adapter-error.js";
import {
  cliResultToOpenai,
  createDoneChunk,
  createUsageChunk,
  extractJsonFromText,
} from "../adapter/cli-to-openai.js";
import type { OpenAIChatRequest } from "../types/openai.js";
import type { ClaudeCliResult, ClaudeCliStreamEvent } from "../types/claude-cli.js";
import { usageTracker, displayCostUsd } from "../usage/tracker.js";
import { isAuthEnabled, requestIsTrusted } from "./auth.js";
import { authAdminEnabled } from "./auth-routes.js";
import { provisionEnabled } from "../provision/sync.js";
import { countReady, engineHealth, rollupStatus } from "./health.js";
import { PKG_VERSION, getTimeoutMs, KEEPALIVE_INTERVAL_MS } from "../config.js";
import { AUTH_UI_AVAILABLE_HEADER } from "../isolation/worker-protocol.js";
import { AUTH_UI_PATH } from "./auth-ui.js";

function authUiPath(req: Request, engine: string | undefined): string | undefined {
  if (!engine) return undefined;
  const role = req.app?.locals.cliProxyRole;
  const available = (role === "gateway" && req.app.locals.authUiEnabled === true)
    || (role === "worker" && req.headers[AUTH_UI_AVAILABLE_HEADER] === "1");
  return available ? `${AUTH_UI_PATH}?engine=${encodeURIComponent(engine)}` : undefined;
}

/**
 * Handle POST /v1/chat/completions
 *
 * Main endpoint for chat requests, supports both streaming and non-streaming
 */
export async function handleChatCompletions(
  req: Request,
  res: Response
): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as OpenAIChatRequest;
  const stream = body.stream === true;
  const requestedModel = body.model || DEFAULT_MODEL;
  const startTime = Date.now();

  try {
    // Validate request
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      });
      return;
    }

    // Materialize any image_url parts to local temp files (data URLs) or inline
    // links (http URLs) BEFORE conversion, so every adapter sees them uniformly.
    // cleanup removes the per-request temp files once the response completes.
    const { messages: preparedMessages, cleanup } = await materializeImages(body.messages);
    try {
      // Convert to CLI input format
      const cliInput = openaiToCli({ ...body, messages: preparedMessages });
      const subprocess = runnerFactory.create(requestedModel);

      if (stream) {
        await handleStreamingResponse(req, res, subprocess, cliInput, requestId, requestedModel, startTime, cliInput.jsonMode, body.stream_options?.include_usage === true);
      } else {
	await handleNonStreamingResponse(req, res, subprocess, cliInput, requestId, requestedModel, startTime, cliInput.jsonMode);
      }
    } finally {
      await cleanup();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[handleChatCompletions] Error:", message);

    usageTracker.record({
      model: requestedModel,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - startTime,
      stream,
      success: false,
    });

    // A bad image (unsupported type, too large, malformed data URL) is a client
    // error — surface it as an OpenAI-style 400 rather than a generic 500.
    if (error instanceof ImageValidationError) {
      if (!res.headersSent) {
        res.status(400).json({
          error: {
            message,
            type: "invalid_request_error",
            code: "invalid_image",
          },
        });
      }
      return;
    }

    // An unregistered paperclip/* model is a client error (unknown model), not a
    // server fault — surface it as an OpenAI-style 404 model_not_found rather than 500.
    if (error instanceof UnknownPaperclipModelError) {
      if (!res.headersSent) {
        res.status(404).json({
          error: {
            message,
            type: "invalid_request_error",
            code: "model_not_found",
          },
        });
      }
      return;
    }

    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message,
          type: "server_error",
          code: null,
        },
      });
    }
  }
}

/**
 * Handle streaming response (SSE)
 *
 * IMPORTANT: The Express req.on("close") event fires when the request body
 * is fully received, NOT when the client disconnects. For SSE connections,
 * we use res.on("close") to detect actual client disconnection.
 */
async function handleStreamingResponse(
  req: Request,
  res: Response,
  subprocess: AgentRunner,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string,
  requestedModel: string,
  startTime: number,
  jsonMode?: boolean,
  includeUsage = false
): Promise<void> {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);

  // CRITICAL: Flush headers immediately to establish SSE connection
  // Without this, headers are buffered and client times out waiting
  res.flushHeaders();

  // Send initial comment to confirm connection is alive
  res.write(":ok\n\n");

  return new Promise<void>((resolve) => {
    let isFirst = true;
    let isComplete = false;
    let jsonBuffer = "";
    let keepaliveInterval: NodeJS.Timeout | null = null;

    // Once usage is requested, the OpenAI contract has every non-terminal chunk
    // carry the key explicitly as null, so a client can read chunk.usage
    // unconditionally instead of feature-detecting it.
    const usagePlaceholder = includeUsage ? { usage: null } : {};

    const clearKeepalive = () => {
      if (keepaliveInterval) {
        clearInterval(keepaliveInterval);
        keepaliveInterval = null;
      }
    };

    // Handle actual client disconnect (response stream closed)
    res.on("close", () => {
      clearKeepalive();
      if (!isComplete) {
        subprocess.kill();
      }
      resolve();
    });

    // Keep the SSE connection warm in every mode: while waiting on a quiet
    // background subagent, no content deltas flow (jsonMode buffers them
    // entirely), so without a periodic comment an idle-connection proxy could
    // close the socket and reap the long run this change is meant to preserve.
    keepaliveInterval = setInterval(() => {
      if (!res.writableEnded) {
        res.write(":keepalive\n\n");
      }
    }, KEEPALIVE_INTERVAL_MS);

    // Handle streaming content deltas
    subprocess.on("content_delta", (event: ClaudeCliStreamEvent) => {
      const text = event.event.delta?.text || "";
      if (text && !res.writableEnded) {
        if (jsonMode) {
          jsonBuffer += text;
        } else {
          const chunk = {
            id: `chatcmpl-${requestId}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: requestedModel,
            choices: [{
              index: 0,
              delta: {
                role: isFirst ? "assistant" : undefined,
                content: text,
              },
              finish_reason: null,
            }],
            ...usagePlaceholder,
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          isFirst = false;
        }
      }
    });

    subprocess.on("result", (result: ClaudeCliResult) => {
      isComplete = true;
      clearKeepalive();

      // Track usage
      usageTracker.record({
        model: requestedModel,
        modelUsage: result.modelUsage,
        mainChainModel: result.mainChainModel,
        inputTokens: result.usage?.input_tokens || 0,
        outputTokens: result.usage?.output_tokens || 0,
        cacheReadTokens: result.usage?.cache_read_input_tokens || 0,
        cacheWriteTokens: result.usage?.cache_creation_input_tokens || 0,
        durationMs: Date.now() - startTime,
        stream: true,
        success: true,
      });

      if (!res.writableEnded) {
        // Extract from the terminal answer, not the raw delta buffer: codex-jsonl
        // streams one delta per agent_message block, so jsonBuffer concatenates
        // intermediate blocks and extractJsonFromText (first-match) could return an
        // intermediate status object. result.result is the canonical final answer
        // (codex: final agent_message; claude: full result text) and equals jsonBuffer
        // for single-block turns.
        const jsonSource = result.result || jsonBuffer;
        if (jsonMode && jsonSource) {
          const extracted = extractJsonFromText(jsonSource);
          const chunk = {
            id: `chatcmpl-${requestId}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: requestedModel,
            choices: [{
              index: 0,
              delta: { role: "assistant" as const, content: extracted },
              finish_reason: null,
            }],
            ...usagePlaceholder,
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        // Send final done chunk with finish_reason
        const doneChunk = { ...createDoneChunk(requestId, requestedModel), ...usagePlaceholder };
        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        // Totals ride their own trailing chunk (empty `choices`) so a client that
        // never asked for them is not handed a chunk whose choices[0] is absent.
        if (includeUsage) {
          res.write(`data: ${JSON.stringify(createUsageChunk(requestId, requestedModel, result))}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    const handleSubprocessError = (error: Error) => {
      isComplete = true;
      console.error("[Streaming] Error:", error.message);
      clearKeepalive();

      usageTracker.record({
        model: requestedModel,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: Date.now() - startTime,
        stream: true,
        success: false,
      });

      // Streaming already flushed a 200 header (keepalive), so the HTTP status can't
      // change — deliver the classified error in-band with the verbatim message so an
      // OpenAI client parses type/code (e.g. insufficient_quota) from the SSE stream.
      const { type, code, message, engine } = openaiErrorFromError(error);
      const authUrl = authUiPath(req, engine);
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
	    error: {
	      message,
	      type,
	      code,
	      ...(engine ? { engine } : {}),
	      ...(authUrl ? { auth_url: authUrl } : {}),
	    },
          })}\n\n`
        );
        res.end();
      }
      resolve();
    };
    subprocess.on("error", handleSubprocessError);

    subprocess.on("close", (code: number | null) => {
      clearKeepalive();
      if (!res.writableEnded) {
        if (code !== 0 && !isComplete) {
          // Abnormal exit without result - send error
          res.write(`data: ${JSON.stringify({
            error: { message: `Process exited with code ${code}`, type: "server_error", code: null },
          })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    // Start the subprocess
    subprocess.start(cliInput.prompt, {
      systemPrompt: cliInput.systemPrompt,
      sessionId: cliInput.sessionId,
      timeout: getTimeoutMs(),
      reasoningEffort: cliInput.reasoningEffort,
    }).catch((err) => {
      // Headers were deliberately flushed above, so rejecting would reach the
      // outer handler too late to write a response and leave this SSE stream open.
      // Treat a failed preflight exactly like an asynchronous runner error.
      handleSubprocessError(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(
  req: Request,
  res: Response,
  subprocess: AgentRunner,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string,
  requestedModel: string,
  startTime: number,
  jsonMode?: boolean
): Promise<void> {
  return new Promise((resolve) => {
    let finalResult: ClaudeCliResult | null = null;
    let isComplete = false;

    // With the request timeout unbounded by default, a client that disconnects
    // (or an intermediary that times out) would otherwise leave the subprocess
    // running forever with nobody to receive the result. Kill it on disconnect.
    res.on("close", () => {
      if (!isComplete) {
        subprocess.kill();
      }
      resolve();
    });

    subprocess.on("result", (result: ClaudeCliResult) => {
      finalResult = result;
    });

    subprocess.on("error", (error: Error) => {
      isComplete = true;
      console.error("[NonStreaming] Error:", error.message);

      usageTracker.record({
        model: requestedModel,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: Date.now() - startTime,
        stream: false,
        success: false,
      });

      // A classified adapter failure (usage limit / auth / unknown model) carries the
      // OpenAI status + type + code; a plain Error is an internal 500. Either way the
      // verbatim message is passed through unchanged.
      const { status, type, code, message, retryAfterSeconds, engine } = openaiErrorFromError(error);
      const authUrl = authUiPath(req, engine);
      if (res.writable) {
        if (retryAfterSeconds != null) res.setHeader("Retry-After", String(retryAfterSeconds));
	res.status(status).json({
	  error: {
	    message,
	    type,
	    code,
	    ...(engine ? { engine } : {}),
	    ...(authUrl ? { auth_url: authUrl } : {}),
	  },
	});
      }
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      isComplete = true;
      if (finalResult) {
        // Track usage
        usageTracker.record({
          model: requestedModel,
          modelUsage: finalResult.modelUsage,
          mainChainModel: finalResult.mainChainModel,
          inputTokens: finalResult.usage?.input_tokens || 0,
          outputTokens: finalResult.usage?.output_tokens || 0,
          cacheReadTokens: finalResult.usage?.cache_read_input_tokens || 0,
          cacheWriteTokens: finalResult.usage?.cache_creation_input_tokens || 0,
          durationMs: Date.now() - startTime,
          stream: false,
          success: true,
        });

        // res.writable is false once the client has disconnected; skip the
        // write (usage is still recorded above) to avoid write-after-end.
        if (res.writable) {
          res.json(cliResultToOpenai(finalResult, requestId, requestedModel, jsonMode));
        }
      } else if (!res.headersSent && res.writable) {
        usageTracker.record({
          model: requestedModel,
          inputTokens: 0,
          outputTokens: 0,
          durationMs: Date.now() - startTime,
          stream: false,
          success: false,
        });

        res.status(500).json({
          error: {
            message: `CLI exited with code ${code} without response`,
            type: "server_error",
            code: null,
          },
        });
      }
      resolve();
    });

    // Start the subprocess
    subprocess
      .start(cliInput.prompt, {
        systemPrompt: cliInput.systemPrompt,
        sessionId: cliInput.sessionId,
        timeout: getTimeoutMs(),
        reasoningEffort: cliInput.reasoningEffort,
      })
      .catch((error) => {
        res.status(500).json({
          error: {
            message: error.message,
            type: "server_error",
            code: null,
          },
        });
        resolve();
      });
  });
}

/**
 * Handle GET /v1/models
 *
 * Returns available models
 */
/**
 * Only paperclip adapters are exposed, and anything unlisted is a 404 — so the
 * advertised set and the accepted set both come from the registry.
 *
 * Each entry names an adapter. A model can be appended as `<id>/<cli-model>`, but
 * the CLI owns the model list, so none are enumerated here.
 */
const MODELS_DATA = (() => {
  const now = Math.floor(Date.now() / 1000);
  return Object.freeze({
    object: "list" as const,
    data: PAPERCLIP_MODEL_IDS.map((id) => ({
      id,
      object: "model" as const,
      owned_by: "paperclip",
      created: now,
    })),
  });
})();

export function handleModels(_req: Request, res: Response): void {
  res.json(MODELS_DATA);
}

/**
 * Handle GET /v1/usage
 *
 * Returns usage statistics and estimated cost savings
 */
export function handleUsage(req: Request, res: Response): void {
  const since = req.query.since ? parseInt(req.query.since as string, 10) : undefined;
  const summary = usageTracker.getSummary(since);

  res.json({
    ...summary,
    maxSubscriptionCostUsd: 200,
    note: "estimatedApiCostSavedUsd shows what these requests would have cost via Anthropic API",
  });
}

/**
 * Handle GET /v1/usage/recent
 *
 * Returns recent request records
 */
export function handleUsageRecent(req: Request, res: Response): void {
  const raw = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
  const limit = Math.min(Math.max(raw || 20, 1), 1000);
  // Records hold the unrounded cost so totals do not drift; a reader gets it
  // rounded, without the float dust a per-model sum can leave behind.
  const records = usageTracker.getRecent(limit).map(record => ({
    ...record,
    estimatedApiCostUsd: displayCostUsd(record.estimatedApiCostUsd),
  }));

  res.json({
    object: "list",
    data: records,
  });
}

/**
 * Handle GET /health — liveness.
 *
 * Answers 200 whenever the process can answer at all, and says nothing an
 * unauthenticated caller should not see. Every consumer of this path (launchd
 * KeepAlive, the docker healthcheck, both installers' probe) responds to a
 * failure by restarting, so it must not reflect anything a restart cannot fix.
 * Engine state is reported by /health/ready instead.
 */
export function handleHealth(req: Request, res: Response): void {
  res.set("Cache-Control", "no-store");
  res.json({
    status: "ok",
    role: roleOf(req),
    uptimeSeconds: Math.floor(process.uptime()),
  });
}

/**
 * Handle GET /health/ready — readiness.
 *
 * Unauthenticated callers get the rollup and a ready/total count; a caller
 * holding a valid API key gets the per-engine detail. The split follows the one
 * knob that already decides this server's exposure (API_KEYS) rather than adding
 * a second: with no keys configured the whole surface is open anyway, so there
 * is nothing left to withhold here.
 */
export function handleHealthReady(req: Request, res: Response): void {
  res.set("Cache-Control", "no-store");
  const detailed = requestIsTrusted(req);
  const perUser = req.app?.locals.userWorkerRouting === true;

  // Under per-user routing the engines live in each worker's HOME, so probing
  // this process would describe a machine no caller's requests actually run on.
  // The gateway can still answer for itself: it is ready to route.
  if (perUser) {
    const body = {
      status: "ok",
      engines: {
        mode: "per-user",
        note: "Engine credentials are per user; ask /v1/auth/:engine/status with your identity.",
      },
    };
    res.json(detailed ? { ...body, ...identity(req), features: featureFlags(true), usage: usageTotals() } : body);
    return;
  }

  const health = engineHealth();
  const status = rollupStatus(health.items);
  if (status === "down") res.status(503);

  if (!detailed) {
    res.json({
      status,
      engines: { ready: countReady(health.items), total: Object.keys(health.items).length },
    });
    return;
  }

  res.json({
    status,
    ...identity(req),
    engines: {
      mode: "host",
      probedAt: health.probedAt === null ? null : new Date(health.probedAt).toISOString(),
      ageMs: health.ageMs,
      stale: health.stale,
      items: health.items,
    },
    features: featureFlags(false),
    usage: usageTotals(),
  });
}

function roleOf(req: Request): string {
  return (req.app?.locals.cliProxyRole as string | undefined) ?? "gateway";
}

function identity(req: Request): Record<string, unknown> {
  const uptime = process.uptime();
  return {
    role: roleOf(req),
    version: PKG_VERSION,
    // From the unrounded uptime: deriving it from the reported (floored) seconds
    // would shift the boot time by up to a second on every call.
    startedAt: new Date(Date.now() - uptime * 1000).toISOString(),
    uptimeSeconds: Math.floor(uptime),
  };
}

function featureFlags(userWorkers: boolean): Record<string, boolean> {
  return {
    apiKeyAuth: isAuthEnabled(),
    authProvisioning: authAdminEnabled(),
    agentProvisioning: provisionEnabled(),
    userWorkers,
  };
}

/**
 * Counters, not a scan: this endpoint is reachable without a key, and the record
 * list it would otherwise filter grows for the life of the install.
 */
function usageTotals(): Record<string, unknown> {
  const totals = usageTracker.getTotals();
  return {
    totalRequests: totals.totalRequests,
    failedRequests: totals.failedRequests,
    lastRequestAt: totals.lastRequestAt === null ? null : new Date(totals.lastRequestAt).toISOString(),
  };
}
