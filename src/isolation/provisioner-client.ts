import http from "node:http";
import {
  getProvisionerEndpoint,
  getWorkerConnectTimeoutMs,
} from "../config.js";
import type {
  IpcEndpoint,
  UserIdentity,
  WorkerProvisioner,
  WorkerTarget,
} from "./types.js";
import { WorkerIsolationError } from "./types.js";

interface ProvisionerResponse {
  accountName: unknown;
  uid?: unknown;
  gid?: unknown;
  home?: unknown;
  endpoint: unknown;
}

function validEndpoint(value: unknown): value is IpcEndpoint {
  if (!value || typeof value !== "object") return false;
  const endpoint = value as Record<string, unknown>;
  return (
    (endpoint.kind === "unix" || endpoint.kind === "named-pipe")
    && typeof endpoint.address === "string"
    && endpoint.address.length > 0
  );
}

function parseTarget(value: ProvisionerResponse): WorkerTarget {
  if (
    !value
    || typeof value.accountName !== "string"
    || !validEndpoint(value.endpoint)
    || (value.uid !== undefined && !Number.isSafeInteger(value.uid))
    || (value.gid !== undefined && !Number.isSafeInteger(value.gid))
    || (value.home !== undefined && typeof value.home !== "string")
  ) {
    throw new WorkerIsolationError("Provisioner returned an invalid worker target", "provisioning_failed");
  }
  return value as WorkerTarget;
}

export class IpcProvisionerClient implements WorkerProvisioner {
  constructor(
    private readonly endpoint: IpcEndpoint,
    private readonly timeoutMs = getWorkerConnectTimeoutMs(),
  ) {}

  ensureWorker(identity: UserIdentity): Promise<WorkerTarget> {
    const body = Buffer.from(JSON.stringify(identity));
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.endpoint.address,
          path: "/v1/users/ensure",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(body.length),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let length = 0;
          response.on("data", (chunk: Buffer) => {
            length += chunk.length;
            if (length > 64 * 1024) {
              request.destroy(new Error("Provisioner response exceeded 64 KiB"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            let payload: unknown;
            try {
              payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              reject(new WorkerIsolationError("Provisioner returned malformed JSON", "provisioning_failed"));
              return;
            }
            if (response.statusCode !== 200) {
              const message =
                typeof payload === "object"
                && payload !== null
                && "error" in payload
                && typeof (payload as { error?: { message?: unknown } }).error?.message === "string"
                  ? (payload as { error: { message: string } }).error.message
                  : `Provisioner returned HTTP ${response.statusCode ?? 0}`;
              reject(new WorkerIsolationError(message, "provisioning_failed"));
              return;
            }
            try {
              resolve(parseTarget(payload as ProvisionerResponse));
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.setTimeout(this.timeoutMs, () => {
        request.destroy(new Error(`Provisioner timed out after ${this.timeoutMs}ms`));
      });
      request.on("error", (error) => {
        reject(new WorkerIsolationError(`Provisioner unavailable: ${error.message}`, "provisioner_unavailable"));
      });
      request.end(body);
    });
  }
}

export function createPlatformProvisioner(
  platform = process.platform,
  endpoint = getProvisionerEndpoint(platform),
): WorkerProvisioner {
  if (platform === "linux") {
    return new IpcProvisionerClient({ kind: "unix", address: endpoint });
  }
  if (platform === "win32") {
    return new IpcProvisionerClient({ kind: "named-pipe", address: endpoint });
  }
  throw new WorkerIsolationError(
    `Per-user workers are not implemented for ${platform}; add a platform WorkerProvisioner adapter`,
    "platform_unsupported",
  );
}
