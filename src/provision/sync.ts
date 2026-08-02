/**
 * The provisioning sync engine: fetch manifest → diff against the lockfile →
 * install / remove → report.
 *
 * Pull-only by design. The proxy decides where it fetches from (registered
 * manifest URL + allowlist), so there is no push channel to replay or forge;
 * drift correction is simply re-fetching the same URL on an interval. Every
 * operation is idempotent — retry IS re-sync.
 *
 * Fail-closed at three layers: PROVISION_SYNC unset disables everything
 * (routes 404, `provisioning_url` on auth sessions is ignored); a first-seen
 * (type, name) stops at pending_approval unless PROVISION_AUTOAPPLY=auto; and
 * removal only ever touches what the lockfile records as ours.
 */

import { homedir } from "os";
import path from "path";
import { checkUrlAllowed, getAllowlist, isValidItemName, parseManifest } from "./manifest.js";
import { installSkill, removeSkill } from "./installer.js";
import { loadState, saveState } from "./state.js";
import {
  ProvisionError,
  SUPPORTED_PROVISION_TYPES,
  type ProvisionItemStatus,
  type ProvisionManifest,
} from "./types.js";

export interface ProvisionItemView {
  type: string;
  name: string;
  status: ProvisionItemStatus;
  sha256?: string;
  error?: string;
}

export interface ProvisionStatusView {
  object: "list";
  enabled: boolean;
  auto_apply: "auto" | "approve";
  manifest_url: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  data: ProvisionItemView[];
}

const DEFAULT_REFETCH_MS = 60 * 60_000;
const MANIFEST_FETCH_TIMEOUT_MS = 30_000;

let enabled = false;
let autoApply: "auto" | "approve" = "approve";
let manifestUrl: string | null = null;
let lastManifest: ProvisionManifest | null = null;
let lastSyncAt: string | null = null;
let lastError: string | null = null;
let itemViews: ProvisionItemView[] = [];
let refetchTimer: NodeJS.Timeout | null = null;
let inFlight: Promise<ProvisionStatusView> | null = null;

function skillsDir(): string {
  return process.env.PROVISION_SKILLS_DIR?.trim() || path.join(homedir(), ".claude", "skills");
}

function refetchMs(): number {
  const raw = process.env.PROVISION_REFETCH_MS;
  if (raw === undefined || raw === "") return DEFAULT_REFETCH_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_REFETCH_MS;
}

export function initProvisioning(): {
  enabled: boolean;
  autoApply: "auto" | "approve";
  manifestUrl: string | null;
} {
  resetProvisioning();
  const raw = process.env.PROVISION_SYNC?.trim().toLowerCase() ?? "";
  enabled = ["1", "true", "yes", "enabled"].includes(raw);
  autoApply = process.env.PROVISION_AUTOAPPLY?.trim().toLowerCase() === "auto" ? "auto" : "approve";
  if (enabled) {
    // What the lockfile already records survives a restart in the status view,
    // so an operator sees their installs before (and without) the next sync.
    itemViews = Object.entries(loadState().installed).map(([key, record]) => {
      const [type, ...rest] = key.split("/");
      return { type: type ?? "skill", name: rest.join("/"), status: "installed" as const, sha256: record.sha256 };
    });
    const fixed = process.env.PROVISION_MANIFEST_URL?.trim();
    if (fixed) registerManifestUrl(fixed);
  }
  return { enabled, autoApply, manifestUrl };
}

export function provisionEnabled(): boolean {
  return enabled;
}

function startRefetchTimer(): void {
  if (refetchTimer) clearInterval(refetchTimer);
  refetchTimer = null;
  const interval = refetchMs();
  if (interval <= 0) return;
  refetchTimer = setInterval(() => {
    void syncNow().catch(() => {
      // recorded in lastError by syncNow; the next tick retries
    });
  }, interval);
  refetchTimer.unref?.();
}

export function registerManifestUrl(url: string): void {
  if (!enabled) return;
  checkUrlAllowed(url, { allowlist: getAllowlist() });
  manifestUrl = url;
  startRefetchTimer();
}

async function fetchManifest(url: string): Promise<ProvisionManifest> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(MANIFEST_FETCH_TIMEOUT_MS) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ProvisionError(`Manifest fetch failed: ${reason}`, "manifest_fetch_failed");
  }
  if (!response.ok) {
    throw new ProvisionError(`Manifest fetch failed: HTTP ${response.status}`, "manifest_fetch_failed");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ProvisionError("Manifest is not valid JSON", "manifest_fetch_failed");
  }
  return parseManifest(body);
}

async function runSync(): Promise<ProvisionStatusView> {
  if (!enabled) {
    throw new ProvisionError("Provisioning is disabled. Set PROVISION_SYNC=1 to enable it.", "provisioning_disabled");
  }
  if (!manifestUrl) {
    throw new ProvisionError("No manifest URL registered.", "no_manifest_url");
  }
  const url = manifestUrl;
  const allowlist = getAllowlist();
  const manifest = await fetchManifest(url);
  lastManifest = manifest;

  const state = loadState();
  const views: ProvisionItemView[] = [];
  const desired = new Set<string>();

  for (const item of manifest.items) {
    const key = `${item.type}/${item.name}`;
    desired.add(key);

    if (!SUPPORTED_PROVISION_TYPES.has(item.type)) {
      views.push({ type: item.type, name: item.name, status: "unsupported" });
      continue;
    }

    // Already-installed items count as approved: they were gated when first
    // installed, and upgrades to an approved name apply without a new stop.
    const approved =
      autoApply === "auto" || state.approved.includes(key) || key in state.installed;
    if (!approved) {
      views.push({ type: item.type, name: item.name, status: "pending_approval", sha256: item.sha256 });
      continue;
    }

    // Idempotency is judged on content hash, not version strings: a registry
    // that re-publishes different bytes under the same name re-installs.
    if (state.installed[key]?.sha256 === item.sha256) {
      views.push({ type: item.type, name: item.name, status: "installed", sha256: item.sha256 });
      continue;
    }

    try {
      checkUrlAllowed(item.url!, { manifestUrl: url, allowlist });
      const result = await installSkill(
        { name: item.name, url: item.url!, sha256: item.sha256! },
        { skillsDir: skillsDir() },
      );
      state.installed[key] = {
        sha256: item.sha256!,
        files: result.files,
        installedAt: new Date().toISOString(),
      };
      if (!state.approved.includes(key)) state.approved.push(key);
      views.push({ type: item.type, name: item.name, status: "installed", sha256: item.sha256 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      views.push({ type: item.type, name: item.name, status: "failed", sha256: item.sha256, error: message });
    }
  }

  // Removal is scoped to the lockfile: only what THIS proxy installed leaves
  // when its manifest entry does. Approval is kept — the name was trusted once,
  // and re-adding it later should not need a second human stop.
  for (const key of Object.keys(state.installed)) {
    if (desired.has(key)) continue;
    const [type, ...rest] = key.split("/");
    const name = rest.join("/");
    try {
      if (type === "skill") removeSkill(name, { skillsDir: skillsDir() });
      delete state.installed[key];
      views.push({ type: type ?? "skill", name, status: "removed" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      views.push({ type: type ?? "skill", name, status: "failed", error: message });
    }
  }

  saveState(state);
  itemViews = views;
  lastSyncAt = new Date().toISOString();
  lastError = null;
  return getStatus();
}

/** Serialized: a sync requested while one runs awaits the running one. */
export async function syncNow(): Promise<ProvisionStatusView> {
  if (inFlight) return inFlight;
  inFlight = runSync()
    .catch((err) => {
      lastError = err instanceof Error ? err.message : String(err);
      throw err;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function getStatus(): ProvisionStatusView {
  return {
    object: "list",
    enabled,
    auto_apply: autoApply,
    manifest_url: manifestUrl,
    last_sync_at: lastSyncAt,
    last_error: lastError,
    data: [...itemViews],
  };
}

export async function approveItem(type: string, name: string): Promise<ProvisionStatusView> {
  const key = `${type}/${name}`;
  // Approval is consent to something the operator has SEEN: only names the
  // current manifest carries can be approved, so the list cannot be pre-seeded
  // with grants for items that never appeared.
  const known = lastManifest?.items.some((item) => item.type === type && item.name === name);
  if (!known) {
    throw new ProvisionError(`No item "${key}" in the current manifest`, "unknown_item");
  }
  const state = loadState();
  if (!state.approved.includes(key)) {
    state.approved.push(key);
    saveState(state);
  }
  return syncNow();
}

export function deleteItem(type: string, name: string): { removed: boolean } {
  if (!isValidItemName(name)) {
    throw new ProvisionError(`Invalid item name "${name}"`, "invalid_item");
  }
  const key = `${type}/${name}`;
  const state = loadState();
  const installed = key in state.installed;
  if (installed && type === "skill") removeSkill(name, { skillsDir: skillsDir() });
  delete state.installed[key];
  // Revoked, not just uninstalled: without this the next sync would silently
  // reinstall, making DELETE a no-op from the operator's point of view.
  state.approved = state.approved.filter((entry) => entry !== key);
  saveState(state);
  itemViews = itemViews.filter((item) => !(item.type === type && item.name === name));
  return { removed: installed };
}

/**
 * Called by the auth session manager when a session reaches "authorized" and
 * carried a `provisioning_url`. Never throws: provisioning failure must not
 * turn a successful login into an error — the outcome lands in last_error.
 */
export async function handleAuthorizedSession(url: string | undefined): Promise<void> {
  if (!enabled || !url) return;
  try {
    registerManifestUrl(url);
    await syncNow();
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }
}

/** Clear module state (not disk). Shutdown and tests; also the first step of init. */
export function resetProvisioning(): void {
  if (refetchTimer) clearInterval(refetchTimer);
  refetchTimer = null;
  enabled = false;
  autoApply = "approve";
  manifestUrl = null;
  lastManifest = null;
  lastSyncAt = null;
  lastError = null;
  itemViews = [];
  inFlight = null;
}
