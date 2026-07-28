/**
 * Express HTTP Server
 *
 * Provides OpenAI-compatible API endpoints that wrap Claude Code CLI
 */

import express, { Express, Request, Response, NextFunction } from "express";
import { createServer, Server } from "http";
import { handleChatCompletions, handleModels, handleHealth, handleUsage, handleUsageRecent } from "./routes.js";
import { initAuth, authMiddleware } from "./auth.js";
import {
  AUTH_PROVISIONING_PREFIX,
  authAdminMiddleware,
  handleAuthEngines,
  handleAuthStatus,
  handleCancelAuthSession,
  handleCreateAuthSession,
  handleForgetCredential,
  handleGetAuthSession,
  handleSubmitAuthSession,
  initAuthAdmin,
} from "./auth-routes.js";
import { getTimeoutMs } from "../config.js";
import { resetSessions } from "../auth/session-manager.js";

export interface ServerConfig {
  port: number;
  host?: string;
}

let serverInstance: Server | null = null;

/**
 * Create and configure the Express app
 */
export function createApp(): Express {
  const app = express();

  // Initialize auth
  const authStatus = initAuth();
  if (authStatus.enabled) {
    console.log(`[Server] API key auth enabled (${authStatus.keyCount} key(s))`);
  }
  const adminStatus = initAuthAdmin();
  console.log(
    adminStatus.enabled
      ? `[Server] CLI auth provisioning enabled (${adminStatus.keyCount} admin key(s))`
      : "[Server] CLI auth provisioning disabled (set AUTH_ADMIN_KEYS to enable)",
  );

  // Request logging (debug mode)
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (process.env.DEBUG) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    }
    next();
  });

  // CORS headers for local development
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    next();
  });

  // Handle OPTIONS preflight
  app.options("*", (_req: Request, res: Response) => {
    res.sendStatus(200);
  });

  // Auth middleware (skips /health automatically). Runs BEFORE the body parser
  // so an unauthenticated request is rejected with 401 without the server first
  // buffering/parsing its (up to 30MB) body. OPTIONS/CORS above stay ahead of it
  // so preflight requests — which carry no Authorization header — still succeed.
  app.use(authMiddleware);

  // Same reason, for the auth-provisioning surface: reject a request carrying the
  // wrong admin key (or one sent while the feature is off) before its body is buffered.
  app.use(AUTH_PROVISIONING_PREFIX, authAdminMiddleware);

  // Body parsing. 30mb accommodates the 20MB decoded-image ceiling plus base64
  // (~33%) overhead and surrounding text, so oversized images hit the clean 400
  // in the image materializer rather than a raw 413 from the body parser.
  app.use(express.json({ limit: "30mb" }));

  // Routes
  app.get("/health", handleHealth);
  app.get("/v1/models", handleModels);
  app.post("/v1/chat/completions", handleChatCompletions);
  app.get("/v1/usage", handleUsage);
  app.get("/v1/usage/recent", handleUsageRecent);

  // CLI auth provisioning (gated above, before the body parser)
  app.get(`${AUTH_PROVISIONING_PREFIX}/engines`, handleAuthEngines);
  app.get(`${AUTH_PROVISIONING_PREFIX}/:engine/status`, handleAuthStatus);
  app.post(`${AUTH_PROVISIONING_PREFIX}/:engine/sessions`, handleCreateAuthSession);
  app.get(`${AUTH_PROVISIONING_PREFIX}/:engine/sessions/:sessionId`, handleGetAuthSession);
  app.post(`${AUTH_PROVISIONING_PREFIX}/:engine/sessions/:sessionId`, handleSubmitAuthSession);
  app.delete(`${AUTH_PROVISIONING_PREFIX}/:engine/sessions/:sessionId`, handleCancelAuthSession);
  app.delete(`${AUTH_PROVISIONING_PREFIX}/:engine/credential`, handleForgetCredential);

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: {
        message: "Not found",
        type: "invalid_request_error",
        code: "not_found",
      },
    });
  });

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[Server Error]:", err.message);
    res.status(500).json({
      error: {
        message: err.message,
        type: "server_error",
        code: null,
      },
    });
  });

  return app;
}

/**
 * Start the HTTP server
 */
export async function startServer(config: ServerConfig): Promise<Server> {
  const { port, host = "127.0.0.1" } = config;

  if (serverInstance) {
    console.log("[Server] Already running, returning existing instance");
    return serverInstance;
  }

  const app = createApp();

  return new Promise((resolve, reject) => {
    serverInstance = createServer(app);

    // A long-running completion (waiting on background subagents) can stay
    // connected for hours with the socket idle between keepalives. Track the
    // configured request timeout (default 0 = never) as the socket inactivity
    // timeout so it isn't severed before the subprocess finishes; a positive
    // TIMEOUT re-imposes the bound here too, matching the subprocess.
    //
    // requestTimeout is intentionally left at Node's default: it only bounds
    // receipt of the request itself (headers + body), a phase that always
    // completes quickly here, and its timer is cleared before the long response
    // phase. Zeroing it would gain nothing and expose a slow-request DoS window.
    serverInstance.timeout = getTimeoutMs(); // socket inactivity timeout

    serverInstance.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use`));
      } else {
        reject(err);
      }
    });

    serverInstance.listen(port, host, () => {
      console.log(`[Server] Claude Code CLI provider running at http://${host}:${port}`);
      console.log(`[Server] OpenAI-compatible endpoint: http://${host}:${port}/v1/chat/completions`);
      console.log(`[Server] Usage dashboard: http://${host}:${port}/v1/usage`);
      resolve(serverInstance!);
    });
  });
}

/**
 * Stop the HTTP server
 */
export async function stopServer(): Promise<void> {
  // Before the early return and before close(): auth sessions live in module
  // state, not on the listener, so a pending paste-code session would keep its
  // pty child alive until its TTL and stay submittable after the next
  // startServer(). Cancelling first also unblocks an in-flight submit, which
  // close() would otherwise wait on.
  resetSessions();

  if (!serverInstance) {
    return;
  }

  return new Promise((resolve, reject) => {
    serverInstance!.close((err) => {
      if (err) {
        reject(err);
      } else {
        console.log("[Server] Stopped");
        serverInstance = null;
        resolve();
      }
    });
  });
}

/**
 * Get the current server instance
 */
export function getServer(): Server | null {
  return serverInstance;
}
