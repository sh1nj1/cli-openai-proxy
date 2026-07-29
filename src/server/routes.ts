/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for Clawdbot integration
 */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { runnerFactory, PAPERCLIP_MODEL_IDS, UnknownPaperclipModelError } from "../adapter/paperclip-registry.js";
import type { AgentRunner } from "../adapter/agent-runner.js";
import { openaiToCli } from "../adapter/openai-to-cli.js";
import { materializeImages, ImageValidationError } from "../adapter/image-materializer.js";
import { openaiErrorFromError } from "../adapter/adapter-error.js";
import {
  cliResultToOpenai,
  createDoneChunk,
  extractJsonFromText,
} from "../adapter/cli-to-openai.js";
import type { OpenAIChatRequest } from "../types/openai.js";
import type { ClaudeCliAssistant, ClaudeCliResult, ClaudeCliStreamEvent } from "../types/claude-cli.js";
import { usageTracker } from "../usage/tracker.js";
import { isAuthEnabled } from "./auth.js";
import { PKG_VERSION, getTimeoutMs, KEEPALIVE_INTERVAL_MS } from "../config.js";

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
  const requestedModel = body.model || "claude-opus-4";
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
        await handleStreamingResponse(req, res, subprocess, cliInput, requestId, requestedModel, startTime, cliInput.jsonMode);
      } else {
        await handleNonStreamingResponse(res, subprocess, cliInput, requestId, requestedModel, startTime, cliInput.jsonMode);
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
  jsonMode?: boolean
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

  return new Promise<void>((resolve, reject) => {
    let isFirst = true;
    let lastModel = requestedModel;
    let isComplete = false;
    let jsonBuffer = "";
    let keepaliveInterval: NodeJS.Timeout | null = null;

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
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          isFirst = false;
        }
      }
    });

    // Handle final assistant message
    subprocess.on("assistant", (_message: ClaudeCliAssistant) => {
      // We use requestedModel instead of CLI-returned model
    });

    subprocess.on("result", (result: ClaudeCliResult) => {
      isComplete = true;
      clearKeepalive();

      // Track usage
      usageTracker.record({
        model: requestedModel,
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
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        // Send final done chunk with finish_reason
        const doneChunk = createDoneChunk(requestId, lastModel);
        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    subprocess.on("error", (error: Error) => {
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
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: { message, type, code, ...(engine ? { engine } : {}) },
          })}\n\n`
        );
        res.end();
      }
      resolve();
    });

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
      model: cliInput.model,
      systemPrompt: cliInput.systemPrompt,
      sessionId: cliInput.sessionId,
      timeout: getTimeoutMs(),
    }).catch((err) => {
      clearKeepalive();
      console.error("[Streaming] Subprocess start error:", err);
      reject(err);
    });
  });
}

/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(
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
      if (res.writable) {
        if (retryAfterSeconds != null) res.setHeader("Retry-After", String(retryAfterSeconds));
        res.status(status).json({ error: { message, type, code, ...(engine ? { engine } : {}) } });
      }
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      isComplete = true;
      if (finalResult) {
        // Track usage
        usageTracker.record({
          model: requestedModel,
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
            message: `Claude CLI exited with code ${code} without response`,
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
        model: cliInput.model,
        systemPrompt: cliInput.systemPrompt,
        sessionId: cliInput.sessionId,
        timeout: getTimeoutMs(),
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
const MODELS_DATA = (() => {
  const now = Math.floor(Date.now() / 1000);
  const baseModels = [
    "claude-opus-4-6",
    "claude-opus-4",
    "claude-sonnet-4-5-20250929",
    "claude-sonnet-4",
    "claude-haiku-4-5-20251001",
    "claude-haiku-4",
  ];
  const prefixes = ["", "openai/", "anthropic/", "claude-max/", "claude-code-cli/"];
  return Object.freeze({
    object: "list" as const,
    data: [
      ...prefixes.flatMap((prefix) =>
        baseModels.map((id) => ({
          id: `${prefix}${id}`,
          object: "model" as const,
          owned_by: "anthropic",
          created: now,
        }))
      ),
      ...PAPERCLIP_MODEL_IDS.map((id) => ({
        id,
        object: "model" as const,
        owned_by: "paperclip",
        created: now,
      })),
    ],
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
  const records = usageTracker.getRecent(limit);

  res.json({
    object: "list",
    data: records,
  });
}

/**
 * Handle GET /health
 *
 * Health check endpoint
 */
export function handleHealth(_req: Request, res: Response): void {
  const summary = usageTracker.getSummary();

  res.json({
    status: "ok",
    provider: "claude-code-cli",
    version: PKG_VERSION,
    auth: isAuthEnabled() ? "enabled" : "disabled",
    usage: {
      totalRequests: summary.totalRequests,
      estimatedSavingsUsd: summary.estimatedApiCostSavedUsd,
    },
    timestamp: new Date().toISOString(),
  });
}
