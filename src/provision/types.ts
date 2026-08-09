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
  /** Archive download URL. Exactly one of archive fields or `git` is required. */
  url?: string;
  /** Hex sha256 of the archive. Required with `url`. */
  sha256?: string;
  /** Public git repository at an immutable commit or named branch. */
  git?: GitProvisionSource;
}

export interface GitProvisionSource {
  url: string;
  /** Full SHA-1/SHA-256 commit object ID or branch name; tags are refused. */
  rev: string;
  /** Repository-relative directory. Omitted means the repository root. */
  path?: string;
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
export const SUPPORTED_PROVISION_TYPES: ReadonlySet<string> = new Set(["skill", "config"]);

/** One filesystem snapshot owned by the proxy. */
export interface InstalledSnapshot {
  /**
   * Desired-source fingerprint. For archives this is the artifact sha256; git
   * sources use a sha256 of their canonical URL, revision, and subpath.
   */
  sha256: string;
  /** Non-secret source metadata used to render status after a restart. */
  source?: { type: "git"; ref: string; rev: string; path?: string };
  /** Paths relative to the item's install dir — what removal may delete. */
  files: string[];
  /** Archive-owned directories, including empty ones, that removal may clean up. */
  directories?: string[];
  /** Per-file content hashes used to detect and repair local drift. */
  fileHashes?: Record<string, string>;
  installedAt: string;
}

/** Durable identity of the staged directory that a first install may expose. */
export interface InstalledDirectoryIdentity {
  /** Decimal filesystem device identifier from lstat(2). */
  dev: string;
  /** Decimal filesystem inode identifier from lstat(2). */
  ino: string;
}

/** Durable identity of a reserved config candidate file. */
export interface InstalledFileIdentity extends InstalledDirectoryIdentity {
  /** Random flat filename below the identity-checked config directory. */
  name: string;
}

/** One proxy-owned skill discovery link. */
export interface InstalledSkillLink extends InstalledDirectoryIdentity {
  /** Absolute link pathname. */
  path: string;
  /** Absolute canonical skill directory the link resolves to. */
  target: string;
}

/** Durable intent written before a skill discovery link becomes visible. */
export interface InstalledSkillLinkPublication {
  /** Absolute link pathname reserved for publication. */
  path: string;
  /** Absolute canonical skill directory the link must resolve to. */
  target: string;
}

/** Legacy owner retained while a replacement is journaled at the new canonical root. */
export interface InstalledLegacySkillMigration {
  /** Original lockfile key, including its legacy case. */
  installedKey: string;
  /** Absolute parent directory of the live legacy skill. */
  installRoot: string;
  /** Physical identity of the isolated legacy tree authorized for restoration. */
  recoveryIdentity: InstalledDirectoryIdentity;
}

/** One installed artifact as the lockfile records it. */
export interface InstalledRecord extends InstalledSnapshot {
  /** Absolute parent directory that owns this skill's canonical tree. */
  installRoot?: string;
  /** Discovery links published for other supported agent CLIs. */
  skillLinks?: InstalledSkillLink[];
  /** In-flight publication that crash recovery may safely finish or remove. */
  skillLinkPublication?: InstalledSkillLinkPublication;
  /**
   * First-install ownership written before exposure. Recovery accepts only the
   * original staged directory identity at the canonical target.
   */
  uncommitted?: true;
  /** Physical identity of the staged skill or config target directory. */
  candidateIdentity?: InstalledDirectoryIdentity;
  /** Reserved config candidate that crash recovery may safely discard. */
  configCandidate?: InstalledFileIdentity;
  /**
   * Random marker placed in the candidate and removed after ownership commits.
   * It is lifecycle metadata, not ownership evidence: its value is readable.
   */
  installMarker?: string;
  /** Rejected-candidate recovery preclaimed before the first install is exposed. */
  rejectionRecoveryId?: string;
  /**
   * Upgrade journal written before the directory swap. The stable snapshot is
   * retained alongside it so either side of an interrupted swap stays owned.
   */
  pending?: InstalledSnapshot;
  /** Old-root ownership retained until a canonical first-install is exposed. */
  legacySkillMigration?: InstalledLegacySkillMigration;
  /** Removal recovery preclaim persisted before the visible target is inspected. */
  removalRecoveryId?: string;
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
  /** One-shot grants allowing a config item to replace colliding untracked files. */
  adopted?: string[];
  /** Exact random identities of retained removal recoveries. */
  removalRecoveries?: string[];
  /** Install root for each retained removal recovery identity. */
  removalRecoveryRoots?: Record<string, string>;
  /** Exact random identities of retained upgrade or rejected-candidate recovery trees. */
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
