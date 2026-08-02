/**
 * Agent provisioning — shared contract.
 *
 * A single JSON manifest ("agent-provisioning/v1") is the whole external
 * interface: a typed item list the proxy pulls, verifies, and installs. The
 * manifest never chooses install paths — each item TYPE maps to a hardcoded
 * sandbox location in this codebase, so the channel cannot be turned into an
 * arbitrary remote file write.
 */

/** One provisionable unit. `type` decides where (and whether) it installs. */
export interface ProvisionItem {
  type: string;
  name: string;
  /** Artifact download URL. Required for supported types, opaque for others. */
  url?: string;
  /** Hex sha256 of the artifact. Required for supported types. */
  sha256?: string;
}

export interface ProvisionManifest {
  schema: "agent-provisioning/v1";
  items: ProvisionItem[];
}

/**
 * Item states a status report can carry. `unsupported` is deliberate: a manifest
 * naming a type this proxy version does not know must surface that fact rather
 * than silently dropping the item (the operator sees "this proxy can't take
 * this yet" instead of nothing).
 */
export type ProvisionItemStatus =
  | "installed"
  | "pending_approval"
  | "unsupported"
  | "removed"
  | "failed";

/** Types this proxy version can install. Everything else reports `unsupported`. */
export const SUPPORTED_PROVISION_TYPES: ReadonlySet<string> = new Set(["skill"]);

/** One filesystem snapshot owned by the proxy. */
export interface InstalledSnapshot {
  sha256: string;
  /** Paths relative to the item's install dir — what removal may delete. */
  files: string[];
  /** Archive-owned directories, including empty ones, that removal may clean up. */
  directories?: string[];
  /** Per-file content hashes used to detect and repair local drift. */
  fileHashes?: Record<string, string>;
  installedAt: string;
}

/** One installed artifact as the lockfile records it. */
export interface InstalledRecord extends InstalledSnapshot {
  /**
   * First-install ownership written before exposure. Recovery uses the random
   * installMarker to decide whether the candidate rename completed.
   */
  uncommitted?: true;
  /**
   * Random marker placed in the candidate before its first atomic exposure.
   * Its presence after restart distinguishes an exposed install from a
   * preclaim whose rename never ran.
   */
  installMarker?: string;
  /**
   * Upgrade journal written before the directory swap. The stable snapshot is
   * retained alongside it so either side of an interrupted swap stays owned.
   */
  pending?: InstalledSnapshot;
}

/**
 * The lockfile: what THIS proxy installed, and which (type, name) pairs an
 * operator has approved. Ownership boundary in one file — sync never touches
 * anything not recorded here.
 */
export interface ProvisionStateFile {
  version: 1;
  approved: string[];
  /** Explicit DELETE tombstones; override auto-apply while the item stays desired. */
  revoked: string[];
  /** Exact random identities of retained removal recoveries. */
  removalRecoveries?: string[];
  /** Exact random identities of retained upgrade staging trees. */
  upgradeRecoveries?: string[];
  installed: Record<string, InstalledRecord>;
}

/** Raised for well-understood provisioning failures so routes answer 4xx/502, not 500. */
export class ProvisionError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "ProvisionError";
  }
}
