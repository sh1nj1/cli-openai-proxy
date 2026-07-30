import http, { type IncomingHttpHeaders } from "node:http";
import type { Request, Response } from "express";
import { getWorkerConnectTimeoutMs } from "../config.js";
import { requestIdentity } from "./request-identity.js";
import type { WorkerProvisioner, WorkerTarget } from "./types.js";
import { WorkerIsolationError } from "./types.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const PRIVATE_HEADERS = new Set([
  "authorization",
  "x-cli-proxy-user-key",
  "x-cli-proxy-tenant-id",
  "x-cli-proxy-user-id",
  "x-cli-proxy-identity-timestamp",
  "x-cli-proxy-identity-signature",
]);

const PUBLIC_FAILURE_MESSAGES: Record<WorkerIsolationError["code"], string> = {
  identity_required: "A trusted user identity is required",
  identity_invalid: "The trusted user identity is invalid",
  platform_unsupported: "Per-user workers are not supported on this platform",
  provisioning_failed: "Unable to provision user worker",
  provisioner_unavailable: "User worker provisioner unavailable",
  worker_unavailable: "User worker unavailable",
};

function outgoingHeaders(headers: IncomingHttpHeaders, body: Buffer): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(lower) && !PRIVATE_HEADERS.has(lower) && lower !== "host" && lower !== "content-length") {
      result[lower] = value;
    }
  }
  result["content-length"] = String(body.length);
  result["content-type"] ??= "application/json";
  return result;
}

function copyResponseHeaders(source: IncomingHttpHeaders, destination: Response): void {
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && !HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      destination.setHeader(name, value);
    }
  }
}

export class UserWorkerProxy {
  constructor(
    private readonly provisioner: WorkerProvisioner,
    private readonly connectTimeoutMs = getWorkerConnectTimeoutMs(),
  ) {}

  async forward(req: Request, res: Response): Promise<void> {
    let target: WorkerTarget;
    try {
      target = await this.provisioner.ensureWorker(requestIdentity(req));
    } catch (error) {
      this.sendFailure(res, error);
      return;
    }

    const body = req.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(req.body));
    await new Promise<void>((resolve) => {
      const upstream = http.request(
        {
          socketPath: target.endpoint.address,
          path: req.originalUrl,
          method: req.method,
          headers: outgoingHeaders(req.headers, body),
        },
        (workerResponse) => {
          res.status(workerResponse.statusCode ?? 502);
          copyResponseHeaders(workerResponse.headers, res);
          workerResponse.pipe(res);
          workerResponse.on("end", resolve);
          workerResponse.on("error", (error) => {
            if (!res.headersSent) this.sendFailure(res, error);
            else res.destroy(error);
            resolve();
          });
        },
      );

      let connected = false;
      upstream.on("socket", (socket) => {
        if (socket.connecting) {
          socket.once("connect", () => {
            connected = true;
            socket.setTimeout(0);
          });
        } else {
          connected = true;
        }
      });
      upstream.setTimeout(this.connectTimeoutMs, () => {
        if (!connected) upstream.destroy(new Error(`Worker connect timed out after ${this.connectTimeoutMs}ms`));
      });
      upstream.on("error", (error) => {
        if (!res.headersSent) this.sendFailure(res, new WorkerIsolationError(
          `Worker ${target.accountName} unavailable: ${error.message}`,
          "worker_unavailable",
        ));
        else res.destroy(error);
        resolve();
      });
      res.on("close", () => {
        if (!upstream.destroyed) upstream.destroy();
      });
      upstream.end(body);
    });
  }

  private sendFailure(res: Response, error: unknown): void {
    if (res.headersSent) return;
    const isolationError =
      error instanceof WorkerIsolationError
        ? error
        : new WorkerIsolationError(error instanceof Error ? error.message : "Worker unavailable", "worker_unavailable");
    const status = isolationError.code === "platform_unsupported" ? 501 : 503;
    console.error(`[UserWorkerProxy] ${isolationError.code}: ${isolationError.message}`);
    res.status(status).json({
      error: { message: PUBLIC_FAILURE_MESSAGES[isolationError.code], type: "server_error", code: isolationError.code },
    });
  }
}
