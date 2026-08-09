import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import path from "node:path";
import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";

export const WORKSPACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_:@-]{0,199}$/;

export interface ProvisionWorkspaceContext {
  workspaceId: string;
  scoped: boolean;
  userHome: string;
  root?: string;
  skillsDir?: string;
  configDir?: string;
  stateDir?: string;
}

const workspaceStorage = new AsyncLocalStorage<ProvisionWorkspaceContext | undefined>();

export function validWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && WORKSPACE_ID_RE.test(value);
}

/** Resolve a named workspace below the configured root and recheck containment. */
export function resolveWorkspaceContext(workspaceId: string): ProvisionWorkspaceContext {
  if (!validWorkspaceId(workspaceId)) {
    throw new Error("workspaceId must be a single stable path segment of at most 200 characters");
  }
  const userHome = homedir();
  const workspaceBase = path.resolve(
    process.env.PROVISION_WORKSPACE_ROOT?.trim() || path.join(userHome, "workspaces"),
  );
  const root = path.resolve(workspaceBase, workspaceId);
  if (path.dirname(root) !== workspaceBase) {
    throw new Error("workspaceId resolves outside the configured workspace root");
  }
  return {
    workspaceId,
    scoped: true,
    userHome,
    root,
    skillsDir: path.join(root, ".agents", "skills"),
    configDir: path.join(root, ".config"),
    stateDir: path.join(root, ".cli-openai-proxy"),
  };
}

function legacyWorkspaceContext(workspaceId: string): ProvisionWorkspaceContext {
  if (!workspaceId || workspaceId.length > 200) {
    throw new Error("legacy workspace identity must be a non-empty string of at most 200 characters");
  }
  return { workspaceId, scoped: false, userHome: homedir() };
}

export function currentWorkspaceContext(): ProvisionWorkspaceContext | undefined {
  return workspaceStorage.getStore();
}

export function currentWorkspaceId(): string | undefined {
  return currentWorkspaceContext()?.workspaceId;
}

export function currentWorkspaceKey(): string {
  const workspace = currentWorkspaceContext();
  return workspace?.scoped ? `workspace:${workspace.workspaceId}` : "legacy";
}

function maxWorkspaces(): number {
  const raw = process.env.PROVISION_MAX_WORKSPACES_PER_USER?.trim();
  if (!raw) return 32;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 32;
}

/** Reserve/create a named workspace before either execution or provisioning writes to it. */
export function ensureWorkspaceRoot(
  workspace = currentWorkspaceContext(),
): ProvisionWorkspaceContext | undefined {
  if (!workspace?.scoped || !workspace.root) return workspace;
  if (existsSync(workspace.root)) {
    if (!lstatSync(workspace.root).isDirectory()) {
      throw new Error(`Workspace root is not a directory: ${workspace.root}`);
    }
    return workspace;
  }
  const base = path.dirname(workspace.root);
  let count = 0;
  try {
    count = readdirSync(base).filter((name) => {
      try {
	return lstatSync(path.join(base, name)).isDirectory();
      } catch {
	return false;
      }
    }).length;
  } catch {
    // The parent is created below; a missing parent contains zero workspaces.
  }
  if (count >= maxWorkspaces()) {
    throw new Error(`Workspace limit (${maxWorkspaces()}) reached for this user`);
  }
  // Synchronous check+create has no event-loop yield, so concurrent requests in
  // this worker cannot both reserve the final slot.
  mkdirSync(workspace.root, { recursive: true, mode: 0o700 });
  return workspace;
}

export function runInWorkspace<T>(
  workspaceId: string | undefined,
  operation: () => T,
  scoped = workspaceId !== undefined,
): T {
  return workspaceId === undefined
    ? operation()
    : workspaceStorage.run(
	scoped ? resolveWorkspaceContext(workspaceId) : legacyWorkspaceContext(workspaceId),
	operation,
      );
}

/** Re-enter the workspace captured when an async resource was created. */
export function runInBoundWorkspace<T>(workspaceId: string | undefined, operation: () => T): T {
  return workspaceStorage.run(
    workspaceId === undefined ? undefined : resolveWorkspaceContext(workspaceId),
    operation,
  );
}
