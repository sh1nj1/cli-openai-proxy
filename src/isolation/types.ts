export interface UserIdentity {
  tenantId: string;
  userId: string;
}

export interface RequestIdentity extends UserIdentity {
  /** Credential routing remains tenantId + userId; this field selects only a path workspace. */
  workspaceId: string;
  /** False for mapped keys and legacy v1 signatures, preserving the legacy HOME layout. */
  workspaceScoped: boolean;
}

export type IpcEndpoint =
  | { kind: "unix"; address: string }
  | { kind: "named-pipe"; address: string };

export interface WorkerTarget {
  accountName: string;
  uid?: number;
  gid?: number;
  home?: string;
  endpoint: IpcEndpoint;
}

export interface WorkerProvisioner {
  ensureWorker(identity: UserIdentity): Promise<WorkerTarget>;
}

export class WorkerIsolationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "identity_required"
      | "identity_invalid"
      | "platform_unsupported"
      | "provisioner_unavailable"
      | "provisioning_failed"
      | "worker_unavailable",
  ) {
    super(message);
    this.name = "WorkerIsolationError";
  }
}
