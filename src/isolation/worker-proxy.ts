import http, { type IncomingHttpHeaders } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const MAX_ISSUED_BINDINGS = 512;
const MAX_ISSUED_STATE_BYTES = 1024 * 1024;
const MAX_SESSION_RESPONSE_BYTES = 64 * 1024;

interface IssuedProvisioningBinding {
  generation: string;
  urlHash: string;
  accountName: string;
  engine: string;
  sessionId?: string;
}

interface IssuedProvisioningState {
  latestGeneration?: string;
  bindings: Map<string, IssuedProvisioningBinding>;
}

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

function loadIssuedProvisioningState(file: string): IssuedProvisioningState {
  try {
    if (statSync(file).size > MAX_ISSUED_STATE_BYTES) return { bindings: new Map() };
    const raw = readFileSync(file, "utf8").trim();
    const legacyGeneration = decodeProvisioningGeneration(raw);
    if (legacyGeneration) return { latestGeneration: legacyGeneration, bindings: new Map() };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version !== 1 || !Array.isArray(parsed.bindings)) return { bindings: new Map() };
    let latestGeneration = decodeProvisioningGeneration(
      typeof parsed.latestGeneration === "string" ? parsed.latestGeneration : undefined,
    );
    const bindings = new Map<string, IssuedProvisioningBinding>();
    for (const value of parsed.bindings.slice(-MAX_ISSUED_BINDINGS)) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const binding = value as Record<string, unknown>;
      const generation = decodeProvisioningGeneration(
	typeof binding.generation === "string" ? binding.generation : undefined,
      );
      if (
	!generation
	|| typeof binding.urlHash !== "string"
	|| !/^[0-9a-f]{64}$/.test(binding.urlHash)
	|| typeof binding.accountName !== "string"
	|| binding.accountName.length === 0
	|| binding.accountName.length > 256
	|| typeof binding.engine !== "string"
	|| binding.engine.length === 0
	|| binding.engine.length > 256
	|| (binding.sessionId !== undefined && (
	  typeof binding.sessionId !== "string"
	  || binding.sessionId.length === 0
	  || binding.sessionId.length > 256
	  || binding.sessionId.includes("/")
	))
      ) continue;
      bindings.set(generation, {
	generation,
	urlHash: binding.urlHash,
	accountName: binding.accountName,
	engine: binding.engine,
	...(typeof binding.sessionId === "string" ? { sessionId: binding.sessionId } : {}),
      });
      if (!latestGeneration || generation > latestGeneration) latestGeneration = generation;
    }
    return { latestGeneration, bindings };
  } catch {
    return { bindings: new Map() };
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

function saveIssuedProvisioningState(file: string, state: IssuedProvisioningState): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  const bindings = [...state.bindings.values()].slice(-MAX_ISSUED_BINDINGS);
  try {
    writeFileSync(temporary, `${JSON.stringify({
      version: 1,
      latestGeneration: state.latestGeneration,
      bindings,
    })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function provisioningGenerationTimestamp(generation: string): number {
  return Number.parseInt(`${generation.slice(0, 8)}${generation.slice(9, 13)}`, 16);
}

function allowedProvisioningUrl(body: unknown): string | undefined {
  const url = (body as Record<string, unknown> | undefined)?.provisioning_url;
  if (typeof url !== "string" || !provisioningUrlFitsHeader(url)) return undefined;
  try {
    checkUrlAllowed(url, { allowlist: getAllowlist() });
    return new URL(url).toString();
  } catch {
    return undefined;
  }
}

function provisioningUrlHash(url: string): string {
  return createHash("sha256").update(new URL(url).toString()).digest("hex");
}

function authSessionCollection(pathname: string): { engine: string } | undefined {
  const match = /^\/v1\/auth\/([^/]+)\/sessions\/?$/.exec(pathname);
  return match ? { engine: match[1]! } : undefined;
}

function authSessionResource(pathname: string): { engine: string; sessionId: string } | undefined {
  const match = /^\/v1\/auth\/([^/]+)\/sessions\/([^/]+)\/?$/.exec(pathname);
  return match ? { engine: match[1]!, sessionId: match[2]! } : undefined;
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
  private readonly issuedProvisioningBindings: Map<string, IssuedProvisioningBinding>;

  constructor(
    private readonly provisioner: WorkerProvisioner,
    private readonly connectTimeoutMs = getWorkerConnectTimeoutMs(),
    private readonly generationStateFile = defaultGenerationStateFile(),
  ) {
    this.latestProvisioningGeneration = loadProvisioningGeneration(generationStateFile);
    const issuedState = loadIssuedProvisioningState(issuedGenerationStateFile(generationStateFile));
    this.issuedProvisioningBindings = issuedState.bindings;
    const latestIssued = issuedState.latestGeneration;
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
    let issuedBinding: IssuedProvisioningBinding | undefined;
    const requestedProvisioningUrl = onAuthorizedProvisioningUrl
      ? allowedProvisioningUrl(req.body)
      : undefined;
    const sessionCollection = authSessionCollection(req.path);
    if (
      onAuthorizedProvisioningUrl
      && requestedProvisioningUrl
      && req.method === "POST"
      && sessionCollection
    ) {
      try {
	issuedBinding = this.issueProvisioningGeneration({
	  url: requestedProvisioningUrl,
	  accountName: target.accountName,
	  engine: sessionCollection.engine,
	});
	provisioningGeneration = issuedBinding.generation;
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
	  const bindingToFinalize = workerResponse.statusCode === 201 ? issuedBinding : undefined;
	  const sessionResponseChunks: Buffer[] = [];
	  let sessionResponseBytes = 0;
	  let sessionResponseTooLarge = false;
	  if (bindingToFinalize) {
	    workerResponse.on("data", (chunk: Buffer | string) => {
	      if (sessionResponseTooLarge) return;
	      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
	      sessionResponseBytes += buffer.length;
	      if (sessionResponseBytes > MAX_SESSION_RESPONSE_BYTES) {
		sessionResponseTooLarge = true;
		sessionResponseChunks.length = 0;
		return;
	      }
	      sessionResponseChunks.push(buffer);
	    });
	  }
	  const provisioningUrl = decodeProvisioningUrl(
	    workerResponse.headers[AUTHORIZED_PROVISIONING_HEADER],
	  );
	  const responseGeneration = decodeProvisioningGeneration(
	    workerResponse.headers[PROVISIONING_GENERATION_HEADER],
	  );
	  if (!bindingToFinalize && provisioningUrl && responseGeneration && onAuthorizedProvisioningUrl) {
	    this.relayProvisioningNotification(
	      provisioningUrl,
	      responseGeneration,
	      target.accountName,
	      req.path,
	      onAuthorizedProvisioningUrl,
	    );
	  }
	  if (!bindingToFinalize) {
	    res.status(workerResponse.statusCode ?? 502);
	    copyResponseHeaders(workerResponse.headers, res);
	    workerResponse.pipe(res);
	  }
	  workerResponse.on("end", () => {
	    if (bindingToFinalize) {
	      const responseBody = sessionResponseTooLarge ? undefined : Buffer.concat(sessionResponseChunks);
	      try {
		if (!responseBody || !this.bindIssuedGenerationToSession(bindingToFinalize, responseBody)) {
		  throw new WorkerIsolationError(
		    "Worker returned an invalid provisioning session response",
		    "worker_unavailable",
		  );
		}
		if (!clientClosed && !res.destroyed) {
		  res.status(workerResponse.statusCode ?? 502);
		  copyResponseHeaders(workerResponse.headers, res);
		  res.end(responseBody);
		}
	      } catch (error) {
		if (!clientClosed && !res.destroyed) this.sendFailure(res, error);
	      }
	    }
	    resolve();
	  });
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

  private issueProvisioningGeneration(options: {
    url: string;
    accountName: string;
    engine: string;
  }): IssuedProvisioningBinding {
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
    const binding: IssuedProvisioningBinding = {
      generation,
      urlHash: provisioningUrlHash(options.url),
      accountName: options.accountName,
      engine: options.engine,
    };
    const previousBindings = new Map(this.issuedProvisioningBindings);
    this.issuedProvisioningBindings.set(generation, binding);
    while (this.issuedProvisioningBindings.size > MAX_ISSUED_BINDINGS) {
      this.issuedProvisioningBindings.delete(this.issuedProvisioningBindings.keys().next().value!);
    }
    // Issuance and its authority boundary must survive restarts before the
    // generation is disclosed to the worker.
    try {
      saveIssuedProvisioningState(issuedGenerationStateFile(this.generationStateFile), {
	latestGeneration: generation,
	bindings: this.issuedProvisioningBindings,
      });
    } catch (error) {
      this.issuedProvisioningBindings.clear();
      for (const [issued, previous] of previousBindings) {
	this.issuedProvisioningBindings.set(issued, previous);
      }
      throw error;
    }
    this.latestIssuedProvisioningGeneration = generation;
    return binding;
  }

  private bindIssuedGenerationToSession(
    binding: IssuedProvisioningBinding,
    responseBody: Buffer,
  ): boolean {
    if (this.issuedProvisioningBindings.get(binding.generation) !== binding) return false;
    let sessionId: unknown;
    try {
      sessionId = (JSON.parse(responseBody.toString("utf8")) as Record<string, unknown>).sessionId;
    } catch {
      return false;
    }
    if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 256 || sessionId.includes("/")) {
      return false;
    }
    const finalized = { ...binding, sessionId };
    this.issuedProvisioningBindings.set(binding.generation, finalized);
    try {
      saveIssuedProvisioningState(issuedGenerationStateFile(this.generationStateFile), {
	latestGeneration: this.latestIssuedProvisioningGeneration,
	bindings: this.issuedProvisioningBindings,
      });
    } catch (error) {
      this.issuedProvisioningBindings.set(binding.generation, binding);
	throw error;
    }
    return true;
  }

  private relayProvisioningNotification(
    url: string,
    generation: string,
    accountName: string,
    requestPath: string,
    callback: (url: string) => void | Promise<void>,
  ): void {
    const binding = this.issuedProvisioningBindings.get(generation);
    const session = authSessionResource(requestPath);
    if (
      !binding?.sessionId
      || !session
      || binding.accountName !== accountName
      || binding.engine !== session.engine
      || binding.sessionId !== session.sessionId
      || binding.urlHash !== provisioningUrlHash(url)
    ) return;
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
