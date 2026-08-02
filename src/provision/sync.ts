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

import { createHash, randomBytes } from "crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import path from "path";
import { takeProxySecret } from "../config.js";
import {
  checkUrlAllowed,
  fetchWithPolicy,
  getAllowlist,
  isValidItemName,
  parseManifest,
  readResponseBody,
} from "./manifest.js";
import { firstInstallMarkerPath, installSkill, removeSkill } from "./installer.js";
import { loadState, saveState } from "./state.js";
import {
  ProvisionError,
  SUPPORTED_PROVISION_TYPES,
  type ProvisionItemStatus,
  type InstalledRecord,
  type InstalledSnapshot,
  type ProvisionManifest,
  type ProvisionStateFile,
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
const MAX_MANIFEST_BYTES = 1024 * 1024;

let enabled = false;
let autoApply: "auto" | "approve" = "approve";
let manifestUrl: string | null = null;
let lastManifest: ProvisionManifest | null = null;
let lastSyncAt: string | null = null;
let lastError: string | null = null;
let itemViews: ProvisionItemView[] = [];
let refetchTimer: NodeJS.Timeout | null = null;
let inFlight: Promise<ProvisionStatusView> | null = null;
let manifestGeneration = 0;
let syncRequested = false;
let operationTail: Promise<void> = Promise.resolve();
let pendingOperations = 0;
let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
let afterFirstInstallMove: ((target: string) => void) | undefined;
let afterRemovalAudit: ((target: string) => void) | undefined;
let afterRemovalIsolation: ((target: string) => void) | undefined;

function serialize<T>(operation: () => Promise<T> | T): Promise<T> {
  pendingOperations += 1;
  const result = operationTail.then(operation, operation);
  operationTail = result.then(
    () => { pendingOperations -= 1; },
    () => { pendingOperations -= 1; },
  );
  return result;
}

function assertAcceptingOperations(): void {
  if (shuttingDown) {
    throw new ProvisionError("Provisioning is shutting down.", "provisioning_disabled");
  }
}

function skillsDir(): string {
  return process.env.PROVISION_SKILLS_DIR?.trim() || path.join(homedir(), ".claude", "skills");
}

function refetchMs(): number {
  const raw = process.env.PROVISION_REFETCH_MS;
  if (raw === undefined || raw === "") return DEFAULT_REFETCH_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_REFETCH_MS;
}

export function initProvisioning(hooks: {
  /** Test seam for a mutation immediately after a first install is exposed. */
  afterFirstInstallMove?: (target: string) => void;
  /** Test seam for a namespace mutation after removal validates ownership. */
  afterRemovalAudit?: (target: string) => void;
  /** Test seam for a namespace mutation after removal isolates the owned root. */
  afterRemovalIsolation?: (target: string) => void;
} = {}): {
  enabled: boolean;
  autoApply: "auto" | "approve";
  manifestUrl: string | null;
} {
  resetProvisioning();
  afterFirstInstallMove = hooks.afterFirstInstallMove;
  afterRemovalAudit = hooks.afterRemovalAudit;
  afterRemovalIsolation = hooks.afterRemovalIsolation;
  const raw = process.env.PROVISION_SYNC?.trim().toLowerCase() ?? "";
  enabled = ["1", "true", "yes", "enabled"].includes(raw);
  autoApply = process.env.PROVISION_AUTOAPPLY?.trim().toLowerCase() === "auto" ? "auto" : "approve";
  // Consume even while provisioning is disabled: a signed URL left in the
  // gateway environment is readable through /proc by same-uid CLI children.
  const fixed = takeProxySecret("PROVISION_MANIFEST_URL")?.trim();
  if (enabled) {
    // What the lockfile already records survives a restart in the status view,
    // so an operator sees their installs before (and without) the next sync.
    itemViews = Object.entries(loadState().installed)
      // An unresolved journal does not prove which complete tree is visible.
      // Leave it out until a target-touching operation reconciles the state.
      .filter(([, record]) => !record.uncommitted && !record.pending)
      .map(([key, record]) => {
	const [type, ...rest] = key.split("/");
	return { type: type ?? "skill", name: rest.join("/"), status: "installed" as const, sha256: record.sha256 };
      });
    if (fixed) {
      registerManifestUrl(fixed);
      // A fixed startup URL is itself a request to provision now. The interval
      // is drift repair, not the first-run trigger (and may be disabled).
      void syncNow().catch(() => {
	// syncNow records lastError; startup remains available for status/retry
      });
    }
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
  assertAcceptingOperations();
  if (!enabled) return;
  checkUrlAllowed(url, { allowlist: getAllowlist() });
  if (manifestUrl !== url) {
    manifestUrl = url;
    manifestGeneration += 1;
    if (inFlight) syncRequested = true;
  }
  startRefetchTimer();
}

async function fetchManifest(url: string): Promise<ProvisionManifest> {
  // Redirect hops obey the same policy as artifacts: same host as the
  // registered URL unless PROVISION_ALLOWLIST says otherwise.
  const response = await fetchWithPolicy(url, {
    checkUrl: (hop) => checkUrlAllowed(hop, { manifestUrl: url, allowlist: getAllowlist() }),
    timeoutMs: MANIFEST_FETCH_TIMEOUT_MS,
    failCode: "manifest_fetch_failed",
  });
  if (!response.ok) {
    throw new ProvisionError(`Manifest fetch failed: HTTP ${response.status}`, "manifest_fetch_failed");
  }
  let body: unknown;
  try {
    const raw = await readResponseBody(response, {
      maxBytes: MAX_MANIFEST_BYTES,
      tooLargeCode: "manifest_fetch_failed",
      readErrorCode: "manifest_fetch_failed",
      label: "Manifest",
    });
    body = JSON.parse(raw.toString("utf8"));
  } catch (err) {
    if (err instanceof ProvisionError) throw err;
    throw new ProvisionError("Manifest is not valid JSON", "manifest_fetch_failed");
  }
  return parseManifest(body);
}

function installedRecordIntact(name: string, record: InstalledSnapshot): boolean {
  if (!record.fileHashes || Object.keys(record.fileHashes).length !== record.files.length) return false;
  const root = path.join(skillsDir(), name);
  try {
    if (!lstatSync(root).isDirectory()) return false;
    if (record.directories?.some((relative) => {
      const directory = path.join(root, ...relative.split("/"));
      return !lstatSync(directory).isDirectory();
    })) return false;
    return record.files.every((relative) => {
      const file = path.join(root, ...relative.split("/"));
      const stat = lstatSync(file);
      if (!stat.isFile()) return false;
      const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
      return record.fileHashes![relative] === digest;
    });
  } catch {
    return false;
  }
}

function installedRecordMatchesEntireTree(name: string, record: InstalledSnapshot): boolean {
  if (!installedRecordIntact(name, record) || record.directories === undefined) return false;
  const root = path.join(skillsDir(), name);
  const expected = new Set([
    ...record.files.map((relative) => `f:${relative}`),
    ...record.directories.map((relative) => `d:${relative}`),
  ]);
  const actual = new Set<string>();
  try {
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
	const full = path.join(directory, entry);
	const relative = path.relative(root, full).split(path.sep).join("/");
	const stat = lstatSync(full);
	if (stat.isDirectory()) {
	  actual.add(`d:${relative}`);
	  walk(full);
	} else if (stat.isFile()) {
	  actual.add(`f:${relative}`);
	} else {
	  throw new Error("Unexpected managed entry type");
	}
      }
    };
    walk(root);
  } catch {
    return false;
  }
  return actual.size === expected.size && [...actual].every((entry) => expected.has(entry));
}

function stableSnapshot(record: InstalledRecord): InstalledSnapshot {
  const {
    pending: _pending,
    uncommitted: _uncommitted,
    installMarker: _installMarker,
    ...stable
  } = record;
  return stable;
}

function firstInstallMarkerStatus(
  name: string,
  marker: string,
): "matching" | "missing" | "modified" {
  const file = firstInstallMarkerPath(path.join(skillsDir(), name), marker);
  try {
    if (!lstatSync(file).isFile()) return "modified";
    return readFileSync(file, "utf8") === marker ? "matching" : "modified";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw err;
  }
}

/** Resolve every first-install journal before its target can be inspected. */
function reconcileFirstInstallJournals(state: ProvisionStateFile): Set<string> {
  let changed = false;
  const rejected = new Set<string>();
  for (const [key, record] of Object.entries(state.installed)) {
    if (!record.uncommitted) continue;
    const name = key.slice(key.indexOf("/") + 1);
    const exposed = record.installMarker !== undefined
      && firstInstallMarkerStatus(name, record.installMarker) === "matching"
      && installedRecordIntact(name, record);
    if (!exposed) {
      delete state.installed[key];
      rejected.add(key);
    } else {
      const next = { ...record };
      delete next.uncommitted;
      state.installed[key] = next;
    }
    changed = true;
  }
  // Persist ownership (or its rejection) before marker cleanup and before any
  // caller is allowed to inspect or mutate the visible target.
  if (changed) saveState(state);

  changed = false;
  for (const [key, record] of Object.entries(state.installed)) {
    if (record.uncommitted || !record.installMarker) continue;
    const name = key.slice(key.indexOf("/") + 1);
    const marker = record.installMarker;
    const markerFile = firstInstallMarkerPath(path.join(skillsDir(), name), marker);
    const markerStatus = firstInstallMarkerStatus(name, marker);
    const next = { ...record };
    let markerFinalized = markerStatus === "missing";
    if (markerStatus === "matching") {
      unlinkSync(markerFile);
      markerFinalized = true;
    } else if (markerStatus === "modified") {
      try {
	if (lstatSync(markerFile).isFile()) {
	  const relative = path.basename(markerFile);
	  const ownedHashes = next.fileHashes ?? Object.fromEntries(next.files.map((owned) => {
	    const ownedFile = path.join(skillsDir(), name, ...owned.split("/"));
	    if (!lstatSync(ownedFile).isFile()) throw new Error("Owned path is no longer a file");
	    return [owned, createHash("sha256").update(readFileSync(ownedFile)).digest("hex")];
	  }));
	  next.files = [...new Set([...next.files, relative])];
	  next.fileHashes = {
	    ...ownedHashes,
	    [relative]: createHash("sha256").update(readFileSync(markerFile)).digest("hex"),
	  };
	  markerFinalized = true;
	}
      } catch (err) {
	if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	markerFinalized = true;
      }
    }
    if (!markerFinalized) continue;
    delete next.installMarker;
    state.installed[key] = next;
    changed = true;
  }
  if (changed) saveState(state);
  return rejected;
}

function prepareRemovalRecovery(state: ProvisionStateFile): {
  recoveryId: string;
} {
  const recoveryId = randomBytes(16).toString("hex");
  state.removalRecoveries = [...(state.removalRecoveries ?? []), recoveryId];
  // Persist the exact identity before its recovery directory can appear.
  saveState(state);
  return { recoveryId };
}

function finalizeRemovalRecoveries(state: ProvisionStateFile): void {
  state.removalRecoveries = (state.removalRecoveries ?? []).filter((recoveryId) =>
    existsSync(path.join(skillsDir(), `.provision-removed-${recoveryId}`))
    || existsSync(path.join(skillsDir(), `.provision-removing-${recoveryId}`)));
}

function prepareUpgradeRecovery(state: ProvisionStateFile): {
  upgradeRecoveryId: string;
} {
  const upgradeRecoveryId = randomBytes(16).toString("hex");
  state.upgradeRecoveries = [
    ...(state.upgradeRecoveries ?? []).filter((recoveryId) =>
      existsSync(path.join(skillsDir(), `.provision-staging-${recoveryId}`))),
    upgradeRecoveryId,
  ];
  // Persist the exact identity before its staging directory can appear.
  saveState(state);
  return { upgradeRecoveryId };
}

function finalizeUpgradeRecoveries(state: ProvisionStateFile): void {
  state.upgradeRecoveries = (state.upgradeRecoveries ?? []).filter((recoveryId) =>
    existsSync(path.join(skillsDir(), `.provision-staging-${recoveryId}`)));
}

function removalSnapshot(record: InstalledRecord): {
  files: string[];
  directories?: string[];
  rootPathSnapshots: Array<{ files: string[]; directories?: string[] }>;
  fileHashes?: Record<string, string | string[]>;
} {
  const snapshots: InstalledSnapshot[] = [record, ...(record.pending ? [record.pending] : [])];
  const files = [...new Set(snapshots.flatMap((snapshot) => snapshot.files))];
  const directories = [...new Set(snapshots.flatMap((snapshot) => snapshot.directories ?? []))];
  const fileHashes: Record<string, string | string[]> = {};
  for (const file of files) {
    const owners = snapshots.filter((snapshot) => snapshot.files.includes(file));
    const hashes = owners.map((snapshot) => snapshot.fileHashes?.[file]);
    if (hashes.every((hash): hash is string => hash !== undefined)) {
      fileHashes[file] = [...new Set(hashes)];
    }
  }
  return {
    files,
    rootPathSnapshots: [
      ...snapshots.map((snapshot) => ({
	files: snapshot.files,
	...(snapshot.directories !== undefined ? { directories: snapshot.directories } : {}),
      })),
      {
	files,
	...(directories.length > 0 ? { directories } : {}),
      },
    ],
    ...(directories.length > 0 ? { directories } : {}),
    ...(Object.keys(fileHashes).length > 0 ? { fileHashes } : {}),
  };
}

function reconcileUpgradeJournal(name: string, record: InstalledRecord): InstalledRecord {
  if (!record.pending) return record;
  // A crash can leave either side of the swap visible. Whichever complete
  // snapshot is on disk becomes stable; if neither is intact, retain both
  // ownership sets so the next install/removal can recover safely.
  if (installedRecordMatchesEntireTree(name, record.pending)) return { ...record.pending };
  if (installedRecordMatchesEntireTree(name, record)) return { ...stableSnapshot(record) };
  return record;
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
  reconcileFirstInstallJournals(state);
  const views: ProvisionItemView[] = [];
  const desired = new Set<string>();

  for (const item of manifest.items) {
    const key = `${item.type}/${item.name}`;
    desired.add(key);

    if (!SUPPORTED_PROVISION_TYPES.has(item.type)) {
      views.push({ type: item.type, name: item.name, status: "unsupported" });
      continue;
    }

    if (state.installed[key]?.pending) {
      const reconciled = reconcileUpgradeJournal(item.name, state.installed[key]!);
      state.installed[key] = reconciled;
      if (reconciled.pending) {
	views.push({
	  type: item.type,
	  name: item.name,
	  status: "failed",
	  sha256: item.sha256,
	  error: `Cannot upgrade "${item.name}" until its interrupted upgrade journal is resolved`,
	});
	continue;
      }
    }

    // Already-installed items count as approved: they were gated when first
    // installed, and upgrades to an approved name apply without a new stop.
    const approved = !state.revoked.includes(key)
      && (autoApply === "auto" || state.approved.includes(key) || key in state.installed);
    if (!approved) {
      views.push({ type: item.type, name: item.name, status: "pending_approval", sha256: item.sha256 });
      continue;
    }

    // Idempotency is judged on content hash, not version strings: a registry
    // that re-publishes different bytes under the same name re-installs.
    if (state.installed[key]?.sha256 === item.sha256
      && !state.installed[key]!.installMarker
      && installedRecordIntact(item.name, state.installed[key]!)) {
      views.push({ type: item.type, name: item.name, status: "installed", sha256: item.sha256 });
      continue;
    }

    // The install target belongs to the lockfile boundary: a directory we did
    // not record is someone else's, and a name collision must not overwrite it.
    if (!(key in state.installed) && existsSync(path.join(skillsDir(), item.name))) {
      views.push({
        type: item.type,
        name: item.name,
        status: "failed",
        sha256: item.sha256,
        error: `Refusing to replace untracked directory "${item.name}" in ${skillsDir()}`,
      });
      continue;
    }

    const checkUrl = (hop: string) => checkUrlAllowed(hop, { manifestUrl: url, allowlist });
    try {
      checkUrl(item.url!);
      const previousRecord = state.installed[key];
      const managedFiles = previousRecord
	? [...new Set([...previousRecord.files, ...(previousRecord.pending?.files ?? [])])]
	: undefined;
      const managedDirectories = previousRecord && previousRecord.directories !== undefined
	&& (!previousRecord.pending || previousRecord.pending.directories !== undefined)
	? [...new Set([
	  ...previousRecord.directories,
	  ...(previousRecord.pending?.directories ?? []),
	])]
	: undefined;
      const managedFileHashes: Record<string, string[]> | undefined = previousRecord
	? {}
	: undefined;
      if (managedFileHashes && previousRecord) {
	for (const snapshot of [previousRecord, previousRecord.pending]) {
	  for (const [file, hash] of Object.entries(snapshot?.fileHashes ?? {})) {
	    const accepted = managedFileHashes[file] ?? [];
	    if (!accepted.includes(hash)) accepted.push(hash);
	    managedFileHashes[file] = accepted;
	  }
	}
      }
      const firstInstallMarker = previousRecord ? undefined : randomBytes(16).toString("hex");
      const upgradeRecovery = previousRecord ? prepareUpgradeRecovery(state) : undefined;
      let result: Awaited<ReturnType<typeof installSkill>>;
      try {
	result = await installSkill(
	  { name: item.name, url: item.url!, sha256: item.sha256! },
	  {
	    skillsDir: skillsDir(),
	    checkUrl,
	    managedFiles,
	    managedDirectories,
	    managedFileHashes,
	    ...upgradeRecovery,
	    firstInstallMarker,
	    afterFirstInstallMove,
	    beforeCommit: (candidate) => {
	      const candidateRecord: InstalledSnapshot = {
		sha256: item.sha256!,
		files: candidate.files,
		directories: candidate.directories,
		fileHashes: candidate.fileHashes,
		installedAt: new Date().toISOString(),
	      };
	      const nextRecord: InstalledRecord = previousRecord
		? { ...stableSnapshot(previousRecord), pending: candidateRecord }
		: {
		  ...candidateRecord,
		  uncommitted: true,
		  installMarker: firstInstallMarker,
		};
	      state.installed[key] = nextRecord;
	      try {
		saveState(state);
	      } catch (err) {
		if (previousRecord) state.installed[key] = previousRecord;
		else delete state.installed[key];
		throw err;
	      }
	      if (!previousRecord) {
		return () => {
		  delete state.installed[key];
		  saveState(state);
		};
	      }
	    },
	  },
	);
      } finally {
	if (upgradeRecovery) finalizeUpgradeRecoveries(state);
      }
      if (!previousRecord && reconcileFirstInstallJournals(state).has(key)) {
	throw new ProvisionError(
	  `First installation of "${item.name}" changed before ownership could be finalized`,
	  "untracked_content",
	);
      }
      // Finalizing drops the upgrade journal. If this save later fails, the
      // persisted stable+pending pair lets the next sync recognize either side.
      state.installed[key] = {
	sha256: item.sha256!,
	files: result.files,
	directories: result.directories,
	fileHashes: result.fileHashes,
	installedAt: new Date().toISOString(),
      };
      if (!state.approved.includes(key)) state.approved.push(key);
      views.push({ type: item.type, name: item.name, status: "installed", sha256: item.sha256 });
    } catch (err) {
      const journal = state.installed[key];
      if (journal?.pending) {
	state.installed[key] = reconcileUpgradeJournal(item.name, journal);
      }
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
      const record = state.installed[key]!;
      if (type === "skill") {
	const recovery = prepareRemovalRecovery(state);
	try {
	  const snapshot = removalSnapshot(record);
	  removeSkill(name, {
	    skillsDir: skillsDir(),
	    ...snapshot,
	    ...recovery,
	    afterRootAudit: afterRemovalAudit,
	    afterRootIsolation: afterRemovalIsolation,
	  });
	} finally {
	  finalizeRemovalRecoveries(state);
	}
      }
      delete state.installed[key];
      views.push({ type: type ?? "skill", name, status: "removed" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      views.push({ type: type ?? "skill", name, status: "failed", error: message });
    }
  }

  // A DELETE tombstone lasts while the manifest still asks for that item. Once
  // it disappears, a later re-add is a fresh desired-state decision.
  state.revoked = state.revoked.filter((key) => desired.has(key));

  saveState(state);
  itemViews = views;
  lastSyncAt = new Date().toISOString();
  lastError = null;
  return getStatus();
}

/** Serialized and coalesced; URL changes during a run queue one follow-up run. */
export async function syncNow(): Promise<ProvisionStatusView> {
  assertAcceptingOperations();
  if (inFlight) return inFlight;
  const loop = async (): Promise<ProvisionStatusView> => {
    let result!: ProvisionStatusView;
    do {
      syncRequested = false;
      const startedGeneration = manifestGeneration;
      try {
	result = await serialize(runSync);
      } catch (err) {
	// A superseded URL's failure must not prevent the newly registered URL
	// from running; only surface an error from the still-current generation.
	if (startedGeneration === manifestGeneration && !syncRequested) throw err;
      }
      if (startedGeneration !== manifestGeneration) syncRequested = true;
    } while (syncRequested);
    return result;
  };
  inFlight = loop()
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
  assertAcceptingOperations();
  const key = `${type}/${name}`;
  // Approval is consent to something the operator has SEEN: only names the
  // current manifest carries can be approved, so the list cannot be pre-seeded
  // with grants for items that never appeared.
  const known = lastManifest?.items.some((item) => item.type === type && item.name === name);
  if (!known) {
    throw new ProvisionError(`No item "${key}" in the current manifest`, "unknown_item");
  }
  if (inFlight) syncRequested = true;
  await serialize(() => {
    const state = loadState();
    state.revoked = state.revoked.filter((entry) => entry !== key);
    if (!state.approved.includes(key)) state.approved.push(key);
    saveState(state);
  });
  return syncNow();
}

export function deleteItem(type: string, name: string): Promise<{ removed: boolean }> {
  assertAcceptingOperations();
  if (!isValidItemName(type) || !isValidItemName(name)) {
    throw new ProvisionError(`Invalid item key "${type}/${name}"`, "invalid_item");
  }
  const key = `${type}/${name}`;
  if (inFlight) syncRequested = true;
  return serialize(() => {
    const state = loadState();
    reconcileFirstInstallJournals(state);
    const installed = key in state.installed;
    const record = state.installed[key];
    if (record && type === "skill") {
      const recovery = prepareRemovalRecovery(state);
      try {
	const snapshot = removalSnapshot(record);
	removeSkill(name, {
	  skillsDir: skillsDir(),
	  ...snapshot,
	  ...recovery,
	  afterRootAudit: afterRemovalAudit,
	  afterRootIsolation: afterRemovalIsolation,
	});
      } finally {
	finalizeRemovalRecoveries(state);
	saveState(state);
      }
    }
    delete state.installed[key];
    // Revoked, not just uninstalled: auto mode must not undo an explicit DELETE.
    state.approved = state.approved.filter((entry) => entry !== key);
    if (!state.revoked.includes(key)) state.revoked.push(key);
    saveState(state);
    itemViews = itemViews.filter((item) => !(item.type === type && item.name === name));
    return { removed: installed };
  });
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

function clearProvisioningState(): void {
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
  manifestGeneration = 0;
  syncRequested = false;
  operationTail = Promise.resolve();
  pendingOperations = 0;
  shuttingDown = false;
  afterFirstInstallMove = undefined;
  afterRemovalAudit = undefined;
  afterRemovalIsolation = undefined;
}

/**
 * Stop accepting work, wait for the active generation and queued mutations,
 * then clear module state. Keeping the promises attached prevents an
 * in-process restart from racing a stale sync against the new instance.
 */
export function shutdownProvisioning(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  if (refetchTimer) clearInterval(refetchTimer);
  refetchTimer = null;
  const active = inFlight;
  const shutdown = (async () => {
    if (active) await active.catch(() => undefined);
    await operationTail;
    clearProvisioningState();
  })();
  shutdownPromise = shutdown.finally(() => {
    shutdownPromise = null;
  });
  return shutdownPromise;
}

/** Clear idle module state (not disk). Tests and the first step of init only. */
export function resetProvisioning(): void {
  if (inFlight || pendingOperations > 0 || shuttingDown) {
    throw new Error("Cannot reset provisioning while operations are active; await shutdownProvisioning()");
  }
  clearProvisioningState();
}
