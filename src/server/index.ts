/**
 * Express HTTP Server
 *
 * Provides OpenAI-compatible API endpoints that wrap Claude Code CLI
 */

import express, { Express, Request, Response, NextFunction, type RequestHandler } from "express";
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
import {
  PROVISION_PREFIX,
  handleProvisionApprove,
  handleProvisionDelete,
  handleProvisionStatus,
  handleProvisionSync,
  provisionAdminMiddleware,
} from "./provision-routes.js";
import { getTimeoutMs } from "../config.js";
import { resetSessions } from "../auth/session-manager.js";
import { handleAuthorizedSession, initProvisioning, shutdownProvisioning } from "../provision/sync.js";
import { initRequestIdentity, requireRequestIdentity } from "../isolation/request-identity.js";
import type { UserWorkerProxy } from "../isolation/worker-proxy.js";

export interface ServerConfig {
  port?: number;
  host?: string;
  fd?: number;
  role?: "gateway" | "worker";
  userWorkerProxy?: UserWorkerProxy;
}

export interface AppConfig {
  role?: "gateway" | "worker";
  userWorkerProxy?: UserWorkerProxy;
  /** Test seam; production defaults to the gateway-owned provisioning engine. */
  onAuthorizedProvisioningUrl?: (url: string) => void | Promise<void>;
}

let serverInstance: Server | null = null;

export function initializeGatewaySecurity(userWorkerRoutingActive = false) {
  const identity = initRequestIdentity();
  if (
    !userWorkerRoutingActive
    && (identity.mappedKeyCount > 0 || identity.signedHeadersEnabled)
  ) {
    throw new Error(
      "USER_API_KEYS and USER_IDENTITY_HMAC_SECRET require active per-user worker routing",
    );
  }
  const auth = initAuth();
  const admin = initAuthAdmin();
  return { identity, auth, admin };
}

/**
 * Create and configure the Express app
 */
export function createApp(config: AppConfig = {}): Express {
  const app = express();
  const role = config.role ?? "gateway";
  const userWorkerProxy = config.userWorkerProxy;
  const onAuthorizedProvisioningUrl = config.onAuthorizedProvisioningUrl ?? handleAuthorizedSession;
  app.locals.cliProxyRole = role;

  if (role === "gateway") {
    // Identity mappings must initialize first: mapped user keys are also valid
    // completion keys, and initAuth captures that combined set.
    const { identity: identityStatus, auth: authStatus, admin: adminStatus } =
      initializeGatewaySecurity(userWorkerProxy !== undefined);
    if (authStatus.enabled) {
      console.log(`[Server] API key auth enabled (${authStatus.keyCount} key(s))`);
    }
    console.log(
      adminStatus.enabled
        ? `[Server] CLI auth provisioning enabled (${adminStatus.keyCount} admin key(s))`
        : "[Server] CLI auth provisioning disabled (set AUTH_ADMIN_KEYS to enable)",
    );
    const provisionStatus = initProvisioning();
    console.log(
      provisionStatus.enabled
        ? `[Server] Agent provisioning enabled (mode: ${provisionStatus.autoApply}`
	  + `${provisionStatus.manifestUrl ? ", fixed manifest configured" : ""})`
        : "[Server] Agent provisioning disabled (set PROVISION_SYNC=1 to enable)",
    );
    if (userWorkerProxy) {
      console.log(
        `[Server] Per-user workers enabled (${identityStatus.mappedKeyCount} mapped key(s), `
        + `signed identity headers ${identityStatus.signedHeadersEnabled ? "enabled" : "disabled"})`,
      );
    }
  }

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
    res.setHeader(
      "Access-Control-Allow-Headers",
      [
        "Content-Type",
        "Authorization",
        "X-CLI-Proxy-User-Key",
        "X-CLI-Proxy-Tenant-ID",
        "X-CLI-Proxy-User-ID",
        "X-CLI-Proxy-Identity-Timestamp",
        "X-CLI-Proxy-Identity-Signature",
      ].join(", "),
    );
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
  if (role === "gateway") app.use(authMiddleware);

  // Same reason, for the auth-provisioning surface: reject a request carrying the
  // wrong admin key (or one sent while the feature is off) before its body is buffered.
  if (role === "gateway") app.use(AUTH_PROVISIONING_PREFIX, authAdminMiddleware);

  // And for agent provisioning — its own opt-in (PROVISION_SYNC) plus the same
  // admin keys, checked before any body is buffered.
  if (role === "gateway") app.use(PROVISION_PREFIX, provisionAdminMiddleware);

  // A valid shared API key alone cannot select an OS user. Resolve the immutable
  // identity before buffering JSON, preserving the same unauthenticated-body DoS
  // boundary as the two API-key gates above.
  if (userWorkerProxy) {
    app.use(
      [
        "/v1/chat/completions",
        "/v1/usage",
        "/v1/usage/recent",
        AUTH_PROVISIONING_PREFIX,
      ],
      requireRequestIdentity,
    );
  }

  // Body parsing. 30mb accommodates the 20MB decoded-image ceiling plus base64
  // (~33%) overhead and surrounding text, so oversized images hit the clean 400
  // in the image materializer rather than a raw 413 from the body parser.
  app.use(express.json({ limit: "30mb" }));

  const scoped = (handler: RequestHandler): RequestHandler[] => {
    if (!userWorkerProxy) return [handler];
    return [
      (req, res) => {
	void userWorkerProxy.forward(req, res, onAuthorizedProvisioningUrl);
      },
    ];
  };

  // Routes
  app.get("/health", handleHealth);
  app.get("/v1/models", handleModels);
  app.post("/v1/chat/completions", ...scoped(handleChatCompletions));
  app.get("/v1/usage", ...scoped(handleUsage));
  app.get("/v1/usage/recent", ...scoped(handleUsageRecent));

  // CLI auth provisioning (gated above, before the body parser)
  app.get(`${AUTH_PROVISIONING_PREFIX}/engines`, ...scoped(handleAuthEngines));
  app.get(`${AUTH_PROVISIONING_PREFIX}/:engine/status`, ...scoped(handleAuthStatus));
  app.post(`${AUTH_PROVISIONING_PREFIX}/:engine/sessions`, ...scoped(handleCreateAuthSession));
  app.get(`${AUTH_PROVISIONING_PREFIX}/:engine/sessions/:sessionId`, ...scoped(handleGetAuthSession));
  app.post(`${AUTH_PROVISIONING_PREFIX}/:engine/sessions/:sessionId`, ...scoped(handleSubmitAuthSession));
  app.delete(`${AUTH_PROVISIONING_PREFIX}/:engine/sessions/:sessionId`, ...scoped(handleCancelAuthSession));
  app.delete(`${AUTH_PROVISIONING_PREFIX}/:engine/credential`, ...scoped(handleForgetCredential));

  // Agent provisioning (gated above). Deliberately NOT scoped(): artifacts
  // install into the GATEWAY process's skills dir. Per-user Linux workers run
  // with their own HOME and do not see it — see docs/provisioning.md.
  app.get(PROVISION_PREFIX, handleProvisionStatus);
  app.post(`${PROVISION_PREFIX}/sync`, handleProvisionSync);
  app.post(`${PROVISION_PREFIX}/items/:type/:name/approve`, handleProvisionApprove);
  app.delete(`${PROVISION_PREFIX}/items/:type/:name`, handleProvisionDelete);

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
  const { port, host = "127.0.0.1", fd, role = "gateway", userWorkerProxy } = config;
  if ((port === undefined) === (fd === undefined)) {
    throw new Error("Exactly one of port or fd must be configured");
  }

  if (serverInstance) {
    console.log("[Server] Already running, returning existing instance");
    return serverInstance;
  }

  const app = createApp({ role, userWorkerProxy });

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
        reject(new Error(fd === undefined ? `Port ${port} is already in use` : `Listener fd ${fd} is already in use`));
      } else {
        reject(err);
      }
    });

    const listening = () => {
      if (fd !== undefined) {
        console.log(`[Server] Per-user worker listening on inherited fd ${fd}`);
      } else {
        console.log(`[Server] Claude Code CLI provider running at http://${host}:${port}`);
        console.log(`[Server] OpenAI-compatible endpoint: http://${host}:${port}/v1/chat/completions`);
        console.log(`[Server] Usage dashboard: http://${host}:${port}/v1/usage`);
      }
      resolve(serverInstance!);
    };
    if (fd !== undefined) serverInstance.listen({ fd }, listening);
    else serverInstance.listen(port!, host, listening);
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

  // Also module state: the refetch timer and registered manifest URL would
  // otherwise survive into (and act during) the next startServer().
  await shutdownProvisioning();

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
