import http, { type IncomingHttpHeaders } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Request, Response } from "express";
import { v7 as uuidv7 } from "uuid";
import { getWorkerConnectTimeoutMs } from "../config.js";
import { checkUrlAllowed, getAllowlist } from "../provision/manifest.js";
import { provisionStateDir } from "../provision/state.js";
import { requestIdentity } from "./request-identity.js";
import type { WorkerProvisioner, WorkerTarget } from "./types.js";
import { WorkerIsolationError } from "./types.js";
import {
  AUTHORIZED_PROVISIONING_HEADER,
  PROVISIONING_GENERATION_HEADER,
  decodeProvisioningGeneration,
  decodeProvisioningUrl,
  provisioningUrlFitsHeader,
} from "./worker-protocol.js";

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
  PROVISIONING_GENERATION_HEADER,
]);

const REGENERATED_BODY_HEADERS = new Set(["content-encoding", "content-length"]);

const PUBLIC_FAILURE_MESSAGES: Record<WorkerIsolationError["code"], string> = {
  identity_required: "A trusted user identity is required",
  identity_invalid: "The trusted user identity is invalid",
  platform_unsupported: "Per-user workers are not supported on this platform",
  provisioning_failed: "Unable to provision user worker",
  provisioner_unavailable: "User worker provisioner unavailable",
  worker_unavailable: "User worker unavailable",
};

function defaultGenerationStateFile(): string {
  return path.join(provisionStateDir(), "provisioning-notification-generation");
}

function issuedGenerationStateFile(notificationStateFile: string): string {
  return `${notificationStateFile}.issued`;
}

function loadProvisioningGeneration(file: string): string | undefined {
  try {
    return decodeProvisioningGeneration(readFileSync(file, "utf8").trim());
  } catch {
    return undefined;
  }
}

function saveProvisioningGeneration(file: string, generation: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${generation}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function provisioningGenerationTimestamp(generation: string): number {
  return Number.parseInt(`${generation.slice(0, 8)}${generation.slice(9, 13)}`, 16);
}

function hasAllowedProvisioningUrl(body: unknown): boolean {
  const url = (body as Record<string, unknown> | undefined)?.provisioning_url;
  if (typeof url !== "string" || !provisioningUrlFitsHeader(url)) return false;
  try {
    checkUrlAllowed(url, { allowlist: getAllowlist() });
    return true;
  } catch {
    return false;
  }
}

function outgoingHeaders(
  headers: IncomingHttpHeaders,
  body: Buffer,
  provisioningGeneration?: string,
): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      !HOP_BY_HOP_HEADERS.has(lower)
      && !PRIVATE_HEADERS.has(lower)
      && !REGENERATED_BODY_HEADERS.has(lower)
      && lower !== "host"
    ) {
      result[lower] = value;
    }
  }
  result["content-length"] = String(body.length);
  result["content-type"] ??= "application/json";
  if (provisioningGeneration) result[PROVISIONING_GENERATION_HEADER] = provisioningGeneration;
  return result;
}

function copyResponseHeaders(source: IncomingHttpHeaders, destination: Response): void {
  for (const [name, value] of Object.entries(source)) {
    if (
      value !== undefined
      && !HOP_BY_HOP_HEADERS.has(name.toLowerCase())
      && name.toLowerCase() !== AUTHORIZED_PROVISIONING_HEADER
      && name.toLowerCase() !== PROVISIONING_GENERATION_HEADER
    ) {
      destination.setHeader(name, value);
    }
  }
}

export class UserWorkerProxy {
  private latestProvisioningGeneration: string | undefined;
  private latestIssuedProvisioningGeneration: string | undefined;

  constructor(
    private readonly provisioner: WorkerProvisioner,
    private readonly connectTimeoutMs = getWorkerConnectTimeoutMs(),
    private readonly generationStateFile = defaultGenerationStateFile(),
  ) {
    this.latestProvisioningGeneration = loadProvisioningGeneration(generationStateFile);
    const latestIssued = loadProvisioningGeneration(issuedGenerationStateFile(generationStateFile));
    this.latestIssuedProvisioningGeneration = latestIssued && (
      !this.latestProvisioningGeneration || latestIssued > this.latestProvisioningGeneration
    ) ? latestIssued : this.latestProvisioningGeneration;
  }

  async forward(
    req: Request,
    res: Response,
    onAuthorizedProvisioningUrl?: (url: string) => void | Promise<void>,
  ): Promise<void> {
    let upstream: http.ClientRequest | undefined;
    let clientClosed = false;
    const closeUpstream = () => {
      clientClosed = true;
      upstream?.destroy();
    };
    res.once("close", closeUpstream);

    let target: WorkerTarget;
    try {
      target = await this.provisioner.ensureWorker(requestIdentity(req));
    } catch (error) {
      res.off("close", closeUpstream);
      if (!clientClosed && !res.destroyed) this.sendFailure(res, error);
      return;
    }
    if (clientClosed || res.destroyed) return;

    const body = req.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(req.body));
    let provisioningGeneration: string | undefined;
    if (
      onAuthorizedProvisioningUrl
      && hasAllowedProvisioningUrl(req.body)
      && req.method === "POST"
      && /^\/v1\/auth\/[^/]+\/sessions\/?$/.test(req.path)
    ) {
      try {
	provisioningGeneration = this.issueProvisioningGeneration();
      } catch (error) {
	res.off("close", closeUpstream);
	if (!clientClosed && !res.destroyed) this.sendFailure(res, error);
	return;
      }
    }
    await new Promise<void>((resolve) => {
      let readinessTimer: ReturnType<typeof setTimeout> | undefined;
      const clearReadinessTimer = () => {
        if (readinessTimer !== undefined) clearTimeout(readinessTimer);
        readinessTimer = undefined;
      };
      const request = http.request(
        {
          socketPath: target.endpoint.address,
          path: req.originalUrl,
          method: req.method,
	  headers: outgoingHeaders(req.headers, body, provisioningGeneration),
        },
        (workerResponse) => {
          clearReadinessTimer();
	  const provisioningUrl = decodeProvisioningUrl(
	    workerResponse.headers[AUTHORIZED_PROVISIONING_HEADER],
	  );
	  const responseGeneration = decodeProvisioningGeneration(
	    workerResponse.headers[PROVISIONING_GENERATION_HEADER],
	  );
	  if (provisioningUrl && responseGeneration && onAuthorizedProvisioningUrl) {
	    this.relayProvisioningNotification(
	      provisioningUrl,
	      responseGeneration,
	      onAuthorizedProvisioningUrl,
	    );
	  }
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
      upstream = request;

      readinessTimer = setTimeout(() => {
        request.destroy(new Error(`Worker readiness timed out after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);
      request.on("error", (error) => {
        clearReadinessTimer();
        if (!res.headersSent) this.sendFailure(res, new WorkerIsolationError(
          `Worker ${target.accountName} unavailable: ${error.message}`,
          "worker_unavailable",
        ));
        else res.destroy(error);
        resolve();
      });
      request.end(body);
    });
    res.off("close", closeUpstream);
  }

  private issueProvisioningGeneration(): string {
    let generation = uuidv7();
    if (this.latestIssuedProvisioningGeneration && generation <= this.latestIssuedProvisioningGeneration) {
      const nextTimestamp = provisioningGenerationTimestamp(this.latestIssuedProvisioningGeneration) + 1;
      if (nextTimestamp > 0xffffffffffff) {
	throw new Error("Provisioning generation space exhausted");
      }
      generation = uuidv7({
	msecs: nextTimestamp,
      });
    }
    // Issuance must survive restarts for monotonic IDs, but only an authorized
    // notification may advance the separate relay watermark.
    saveProvisioningGeneration(issuedGenerationStateFile(this.generationStateFile), generation);
    this.latestIssuedProvisioningGeneration = generation;
    return generation;
  }

  private recordIssuedProvisioningGeneration(generation: string): void {
    if (!this.latestIssuedProvisioningGeneration || generation > this.latestIssuedProvisioningGeneration) {
      this.latestIssuedProvisioningGeneration = generation;
    }
  }

  private relayProvisioningNotification(
    url: string,
    generation: string,
    callback: (url: string) => void | Promise<void>,
  ): void {
    try {
      checkUrlAllowed(url, { allowlist: getAllowlist() });
    } catch {
      return;
    }
    if (this.latestProvisioningGeneration && generation < this.latestProvisioningGeneration) return;
    if (!this.latestProvisioningGeneration || generation > this.latestProvisioningGeneration) {
      try {
	// Persist before relay so a gateway restart cannot make an older retained
	// authorized worker session authoritative again. Same-generation retries stay valid.
	saveProvisioningGeneration(this.generationStateFile, generation);
	this.latestProvisioningGeneration = generation;
	this.recordIssuedProvisioningGeneration(generation);
      } catch (error) {
	console.error(
	  `[UserWorkerProxy] provisioning generation persistence failed: ${error instanceof Error ? error.message : String(error)}`,
	);
	return;
      }
    }
    void Promise.resolve(callback(url)).catch((error) => {
      console.error(
	`[UserWorkerProxy] provisioning notification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private sendFailure(res: Response, error: unknown): void {
    if (res.headersSent || res.destroyed) return;
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
