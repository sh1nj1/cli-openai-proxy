/**
 * Skill artifact installer: download → sha256 → safe extraction → static audit
 * → atomic swap into the type's sandbox directory.
 *
 * The pipeline is fail-closed at every stage and nothing is executed from the
 * archive — installation is file placement only. The audit mirrors the checks
 * Paperclip applies to imported skills (no binaries, size caps, no
 * pipe-download-into-shell instructions): with no signature scheme in v1, hash
 * pinning guarantees WHAT arrived and the audit bounds what it can say.
 */

import { execFile, execFileSync, spawn } from "child_process";
import { createHash, randomBytes } from "crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";
import { gunzipSync } from "zlib";
import { fetchWithPolicy, readResponseBody } from "./manifest.js";
import { isGitObjectId } from "./git-source.js";
import { managedPathParts, MAX_MANAGED_PATH_LENGTH } from "./path-policy.js";
import { renameDirectoryNoReplace } from "./rename-no-replace.js";
import {
  ProvisionError,
  type GitProvisionSource,
  type InstalledDirectoryIdentity,
} from "./types.js";

export interface InstallResult {
  /** Installed file paths relative to the skill's directory. */
  files: string[];
  /** Installed directory paths, including empty directories. */
  directories: string[];
  /** Hashes of installed contents, used by periodic drift repair. */
  fileHashes: Record<string, string>;
}

const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
/** Content cap plus slack for tar headers and padding (~512B per entry). */
const MAX_DECOMPRESSED_BYTES = MAX_TOTAL_BYTES + 1024 * 1024;
const MAX_GIT_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_GIT_FETCH_BYTES = 16 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const INSTALL_MARKER_PATTERN = /^[0-9a-f]{32}$/;
const RECOVERY_ID_PATTERN = /^[0-9a-f]{32}$/;
const REMOVAL_RECOVERY_PREFIX = ".provision-removed-";
const UPGRADE_RECOVERY_PREFIX = ".provision-staging-";
const REJECTED_RECOVERY_PREFIX = ".provision-rejected-";
const execFileAsync = promisify(execFile);

/** Same lowercase charset the manifest enforces; re-checked for non-manifest callers. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Removal also accepts pre-canonicalization lockfile names so they can migrate safely. */
const LEGACY_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function firstInstallMarkerPath(root: string, marker: string): string {
  if (!INSTALL_MARKER_PATTERN.test(marker)) {
    throw new ProvisionError("Invalid first-install marker", "invalid_item");
  }
  return path.join(root, `.provision-install-${marker}`);
}

/**
 * A skill is instructions loaded into a model's prompt; one that tells the
 * agent to pipe a download into a shell defeats the "no execution at install
 * time" guarantee at USE time instead. Heuristics, not proof — the TOFU
 * approval gate is the backstop for what these cannot see.
 */
const REMOTE_EXEC_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:curl|wget)\b[^\n]*\|\s*(?:ba|z|da)?sh\b/, "pipes a download into a shell"],
  [/\beval\s*"?\$\(/, "evals command substitution"],
];

async function download(url: string, checkUrl?: (url: string) => void): Promise<Buffer> {
  const response = await fetchWithPolicy(url, {
    checkUrl: checkUrl ?? (() => {}),
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    failCode: "download_failed",
  });
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // Cancellation is best-effort; the HTTP failure must still be reported.
    }
    throw new ProvisionError(`Download failed: HTTP ${response.status}`, "download_failed");
  }
  // The cap is enforced WHILE the body streams: a host that sends an oversized
  // or never-ending body is cut off at the limit, not buffered to completion.
  return readResponseBody(response, {
    maxBytes: MAX_ARCHIVE_BYTES,
    tooLargeCode: "archive_rejected",
    readErrorCode: "download_failed",
    label: "Archive",
  });
}

/**
 * Extraction writes whatever the gzip stream expands to, so the expansion is
 * bounded BEFORE tar runs: a small archive that decompresses to gigabytes (a
 * gzip bomb) must never reach the filesystem. The audit's per-file/total caps
 * remain as the backstop for what fits under this bound.
 */
function assertDecompressionBounded(buf: Buffer): void {
  try {
    gunzipSync(buf, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw new ProvisionError(
        `Archive decompresses beyond ${MAX_DECOMPRESSED_BYTES} bytes`,
        "archive_rejected",
      );
    }
    throw new ProvisionError("Artifact is not a readable tar.gz", "archive_rejected");
  }
}

/**
 * Reject hostile archives from the member listing, BEFORE extraction: link
 * entries (a symlinked directory would let a later entry write through it) and
 * any traversal or absolute name.
 */
function assertArchiveSafe(archivePath: string, compressed = true): boolean {
  let verbose: string;
  let names: string;
  try {
    const opts = { encoding: "utf-8" as const, maxBuffer: MAX_ARCHIVE_BYTES };
    verbose = execFileSync("tar", [compressed ? "-tvzf" : "-tvf", archivePath], opts);
    names = execFileSync("tar", [compressed ? "-tzf" : "-tf", archivePath], opts);
  } catch {
    throw new ProvisionError(
      compressed ? "Artifact is not a readable tar.gz" : "Git source is not a readable tar archive",
      "archive_rejected",
    );
  }
  const verboseEntries = verbose.split("\n").filter(Boolean);
  for (const line of verboseEntries) {
    if (line[0] === "l" || line[0] === "h") {
      throw new ProvisionError("Archive contains a link entry", "archive_rejected");
    }
  }
  const archiveNames = names.split("\n").filter(Boolean);
  for (const name of archiveNames) {
    const relative = name.replace(/\/+$/, "");
    if (relative.length > MAX_MANAGED_PATH_LENGTH) {
      throw new ProvisionError(
	`Archive entry path exceeds ${MAX_MANAGED_PATH_LENGTH} characters`,
	"archive_rejected",
      );
    }
    if (path.isAbsolute(name) || name.split("/").includes("..")) {
      throw new ProvisionError(`Archive entry escapes its root: ${name}`, "archive_rejected");
    }
  }
  const members = archiveNames
    .map((name, index) => ({
      name,
      isDirectory: verboseEntries[index]?.[0] === "d",
      parts: name.replace(/\/+$/, "").split("/").filter((part) => part !== "."),
    }))
    .filter((entry) => entry.parts.length > 0);
  const wrapper = members[0]?.parts[0];
  return wrapper !== undefined
    && members.every((entry) => entry.parts[0] === wrapper)
    && members.some((entry) => entry.parts.length > 1)
    && !members.some((entry) => entry.parts.length === 1 && !entry.isDirectory);
}

type InstallSkillItem =
  | { name: string; url: string; sha256: string; git?: never }
  | {
      name: string;
      git: GitProvisionSource;
      resolvedGitRevision?: string;
      url?: never;
      sha256?: never;
    };

interface PreparedSource {
  archivePath: string;
  compressed: boolean;
  stripWrapper: boolean;
}

const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
const GIT_CONFIG_ARGS = [
  "-c", `core.hooksPath=${NULL_DEVICE}`,
  "-c", "credential.helper=",
  "-c", "protocol.allow=never",
  "-c", "protocol.https.allow=always",
  "-c", "protocol.http.allow=always",
  "-c", "http.followRedirects=false",
  "-c", "submodule.recurse=false",
];

function gitEnvironment(): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return {
    ...inherited,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_TERMINAL_PROMPT: "0",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_NO_LAZY_FETCH: "1",
  };
}

function gitError(err: unknown): ProvisionError {
  return (err as NodeJS.ErrnoException).code === "ENOENT"
    ? new ProvisionError("git is required to install a git source", "git_unavailable")
    : new ProvisionError("Git source fetch or inspection failed", "git_fetch_failed");
}

async function runGit(args: string[], opts: { cwd?: string; maxBuffer?: number } = {}): Promise<string> {
  try {
    const result = await execFileAsync("git", [...GIT_CONFIG_ARGS, ...args], {
      cwd: opts.cwd,
      encoding: "utf8",
      maxBuffer: opts.maxBuffer ?? MAX_GIT_METADATA_BYTES,
      timeout: DOWNLOAD_TIMEOUT_MS,
      env: gitEnvironment(),
    });
    return result.stdout;
  } catch (err) {
    throw gitError(err);
  }
}

async function runGitArchive(args: string[], cwd: string): Promise<Buffer> {
  try {
    const result = await execFileAsync("git", [...GIT_CONFIG_ARGS, ...args], {
      cwd,
      encoding: null,
      maxBuffer: MAX_DECOMPRESSED_BYTES,
      timeout: DOWNLOAD_TIMEOUT_MS,
      env: gitEnvironment(),
    });
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new ProvisionError(
	`Git source archive exceeds ${MAX_DECOMPRESSED_BYTES} bytes`,
	"audit_failed",
      );
    }
    throw gitError(err);
  }
}

function directorySize(root: string): number {
  let total = 0;
  const visit = (entryPath: string): void => {
    let stat;
    try {
      stat = lstatSync(entryPath);
    } catch {
      return;
    }
    if (!stat.isDirectory()) {
      total += stat.size;
      return;
    }
    let entries: string[];
    try {
      entries = readdirSync(entryPath);
    } catch {
      return;
    }
    for (const entry of entries) visit(path.join(entryPath, entry));
  };
  visit(root);
  return total;
}

/**
 * A remote may ignore partial-clone filters. Bound the incoming pack while git
 * runs so content outside the selected path cannot consume unbounded disk.
 */
async function runBoundedGitFetch(args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn("git", [...GIT_CONFIG_ARGS, ...args], {
      cwd,
      detached,
      env: gitEnvironment(),
      stdio: "ignore",
    });
    let settled = false;
    let exceeded = false;
    let timedOut = false;

    const terminate = (): void => {
      if (child.pid === undefined) return;
      try {
	if (detached) process.kill(-child.pid, "SIGKILL");
	else child.kill("SIGKILL");
      } catch {
	// The process may have exited between inspection and termination.
      }
    };
    const finish = (err?: ProvisionError): void => {
      if (settled) return;
      settled = true;
      clearInterval(sizeTimer);
      clearTimeout(timeoutTimer);
      if (err) reject(err);
      else resolve();
    };
    const sizeTimer = setInterval(() => {
      if (directorySize(cwd) <= MAX_GIT_FETCH_BYTES) return;
      exceeded = true;
      terminate();
    }, 10);
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, DOWNLOAD_TIMEOUT_MS);

    child.once("error", (err) => finish(gitError(err)));
    child.once("close", (code) => {
      if (exceeded || directorySize(cwd) > MAX_GIT_FETCH_BYTES) {
	finish(new ProvisionError(
	  `Git fetch exceeds ${MAX_GIT_FETCH_BYTES} bytes`,
	  "audit_failed",
	));
	return;
      }
      if (timedOut || code !== 0) {
	finish(new ProvisionError("Git source fetch or inspection failed", "git_fetch_failed"));
	return;
      }
      finish();
    });
  });
}

function validateGitRepositoryUrl(url: string, checkUrl?: (url: string) => void): void {
  checkUrl?.(url);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProvisionError("Git repository URL is invalid", "invalid_url");
  }
  // Public HTTPS only. Query strings commonly carry private credentials and
  // would also be visible in the git argv. Loopback HTTP exists for tests.
  const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (parsed.username || parsed.password
    || (parsed.protocol !== "https:"
      && !(parsed.protocol === "http:" && loopback.has(parsed.hostname.toLowerCase())))) {
    throw new ProvisionError("Git repository URL must use public HTTPS", "url_not_allowed");
  }
  if (parsed.search || parsed.hash) {
    throw new ProvisionError("Git repository URLs cannot contain a query or fragment", "url_not_allowed");
  }
}

/** Resolve a mutable branch to the commit that this sync will install. */
export async function resolveGitRevision(
  source: GitProvisionSource,
  checkUrl?: (url: string) => void,
): Promise<string> {
  validateGitRepositoryUrl(source.url, checkUrl);
  if (isGitObjectId(source.rev)) return source.rev.toLowerCase();

  const fullRef = `refs/heads/${source.rev}`;
  const output = await runGit(["ls-remote", "--refs", source.url, fullRef]);
  const matches = output.trim().split("\n").filter(Boolean);
  if (matches.length !== 1) {
    throw new ProvisionError("Git branch did not resolve to one commit", "git_revision_not_found");
  }
  const [revision, advertisedRef, ...extra] = matches[0]!.split("\t");
  if (!isGitObjectId(revision) || advertisedRef !== fullRef || extra.length > 0) {
    throw new ProvisionError("Git branch returned an invalid revision", "git_revision_mismatch");
  }
  return revision.toLowerCase();
}

async function prepareGitSource(
  source: GitProvisionSource,
  resolvedRevision: string | undefined,
  temporary: string,
  checkUrl?: (url: string) => void,
): Promise<PreparedSource> {
  const revision = resolvedRevision ?? await resolveGitRevision(source, checkUrl);
  if (!isGitObjectId(revision)) {
    throw new ProvisionError("Resolved git revision must be a full commit SHA", "git_revision_mismatch");
  }
  // A pre-resolved revision came from the sync engine; still enforce URL policy
  // here so direct installer callers cannot bypass it.
  if (resolvedRevision !== undefined) validateGitRepositoryUrl(source.url, checkUrl);

  const repository = path.join(temporary, "repository.git");
  await runGit([
    "init",
    "--bare",
    ...(revision.length === 64 ? ["--object-format=sha256"] : []),
    repository,
  ]);
  const fetchRefspecs = isGitObjectId(source.rev)
    ? [
	"+refs/heads/*:refs/provision/heads/*",
	"+refs/tags/*:refs/provision/tags/*",
      ]
    : [
	`+refs/heads/${source.rev}:refs/provision/heads/${source.rev}`,
      ];
  await runBoundedGitFetch([
    "fetch",
    "--depth=1",
    "--filter=blob:limit=1048577",
    "--no-tags",
    source.url,
    ...fetchRefspecs,
  ], repository);

  const gitObjectType = async (): Promise<string | undefined> => {
    try {
      return (await runGit(["cat-file", "-t", revision], { cwd: repository })).trim();
    } catch {
      return undefined;
    }
  };
  let objectType = await gitObjectType();
  if (objectType === undefined) {
    // A pin may be older than every advertised tip, or a branch may advance
    // after resolution. Deepen through the advertised refs; ordinary servers
    // reject requesting the now-unadvertised commit object directly.
    await runBoundedGitFetch([
      "fetch",
      "--unshallow",
      "--filter=blob:limit=1048577",
      "--no-tags",
      source.url,
      ...fetchRefspecs,
    ], repository);
    objectType = await gitObjectType();
  }
  if (objectType === undefined) {
    throw new ProvisionError("Git source did not contain the expected commit", "git_revision_mismatch");
  }
  if (objectType !== "commit") {
    throw new ProvisionError("Git source did not resolve to a commit", "git_revision_mismatch");
  }
  const containingRef = (await runGit([
    "for-each-ref",
    "--count=1",
    "--format=%(refname)",
    `--contains=${revision}`,
    "refs/provision",
  ], { cwd: repository })).trim();
  if (containingRef.length === 0) {
    throw new ProvisionError("Git source did not resolve to the expected commit", "git_revision_mismatch");
  }

  const treeish = source.path ? `${revision}:${source.path}` : revision;
  if (source.path) {
    const entries = (await runGit([
      "--literal-pathspecs", "ls-tree", "-d", "-z", revision, "--", source.path,
    ], { cwd: repository })).split("\0").filter(Boolean);
    if (entries.length !== 1
      || !entries[0]!.startsWith("040000 tree ")
      || entries[0]!.split("\t")[1] !== source.path) {
      throw new ProvisionError("Git source path is not a directory", "git_path_not_found");
    }
  }
  const tree = await runGit(["ls-tree", "-r", treeish], {
    cwd: repository,
    maxBuffer: MAX_GIT_METADATA_BYTES,
  });
  if (tree.split("\n").some((entry) => entry.startsWith("160000 commit "))) {
    throw new ProvisionError("Git source contains a submodule", "git_source_rejected");
  }
  const missing = await runGit([
    "rev-list",
    "--objects",
    "--missing=print",
    revision,
    ...(source.path ? ["--", source.path] : []),
  ], {
    cwd: repository,
    maxBuffer: MAX_GIT_METADATA_BYTES,
  });
  if (missing.split("\n").some((entry) => entry.startsWith("?"))) {
    throw new ProvisionError(
      `Git source contains a file exceeding ${MAX_FILE_BYTES} bytes`,
      "audit_failed",
    );
  }

  const archivePath = path.join(temporary, "git-source.tar");
  const archive = await runGitArchive(["archive", "--format=tar", treeish], repository);
  writeFileSync(archivePath, archive);
  assertArchiveSafe(archivePath, false);
  return { archivePath, compressed: false, stripWrapper: false };
}

async function prepareSource(
  item: InstallSkillItem,
  temporary: string,
  checkUrl?: (url: string) => void,
): Promise<PreparedSource> {
  if (item.git) {
    return prepareGitSource(item.git, item.resolvedGitRevision, temporary, checkUrl);
  }

  const buf = await download(item.url, checkUrl);
  const digest = createHash("sha256").update(buf).digest("hex");
  if (digest !== item.sha256.toLowerCase()) {
    throw new ProvisionError(
      `sha256 mismatch for "${item.name}": manifest pinned ${item.sha256}, artifact is ${digest}`,
      "sha256_mismatch",
    );
  }
  assertDecompressionBounded(buf);
  const archivePath = path.join(temporary, "artifact.tgz");
  writeFileSync(archivePath, buf);
  return {
    archivePath,
    compressed: true,
    stripWrapper: assertArchiveSafe(archivePath),
  };
}

/** Walk the extracted tree, enforcing the audit, returning relative file paths. */
function auditTree(root: string): InstallResult {
  const files: string[] = [];
  const directories: string[] = [];
  const fileHashes = Object.create(null) as Record<string, string>;
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        throw new ProvisionError("Extracted tree contains a symlink", "archive_rejected");
      }
      if (stat.isDirectory()) {
	const relative = path.relative(root, full).split(path.sep).join("/");
	if (!managedPathParts(relative)) {
	  throw new ProvisionError(`Archive path cannot be recorded: ${relative}`, "archive_rejected");
	}
	directories.push(relative);
        walk(full);
        continue;
      }
      if (!stat.isFile()) {
        throw new ProvisionError(`Not a regular file: ${entry}`, "archive_rejected");
      }
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (!managedPathParts(relative)) {
	throw new ProvisionError(`Archive path cannot be recorded: ${relative}`, "archive_rejected");
      }
      if (stat.size > MAX_FILE_BYTES) {
        throw new ProvisionError(`File exceeds ${MAX_FILE_BYTES} bytes: ${relative}`, "audit_failed");
      }
      total += stat.size;
      if (total > MAX_TOTAL_BYTES) {
        throw new ProvisionError(`Contents exceed ${MAX_TOTAL_BYTES} bytes`, "audit_failed");
      }
      const contents = readFileSync(full);
      if (contents.includes(0)) {
        throw new ProvisionError(`Binary file refused: ${relative}`, "audit_failed");
      }
      const text = contents.toString("utf-8");
      for (const [pattern, why] of REMOTE_EXEC_PATTERNS) {
        if (pattern.test(text)) {
          throw new ProvisionError(`${relative} ${why}`, "audit_failed");
        }
      }
      files.push(relative);
      fileHashes[relative] = createHash("sha256").update(contents).digest("hex");
    }
  };
  walk(root);
  return { files, directories, fileHashes };
}

/** Ensure the gateway can audit, replace, and remove extracted content. */
function normalizeDirectoryMode(directory: string): void {
  const stat = lstatSync(directory);
  chmodSync(directory, stat.mode | 0o700);
}

function normalizeExtractedModes(root: string): void {
  const walk = (dir: string): void => {
    normalizeDirectoryMode(dir);
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = lstatSync(full);
      if (stat.isDirectory()) {
	walk(full);
      } else if (stat.isFile()) {
	chmodSync(full, stat.mode | 0o400);
      }
    }
  };
  walk(root);
}

export async function installSkill(
  item: InstallSkillItem,
  opts: {
    skillsDir: string;
    checkUrl?: (url: string) => void;
    /** Persist ownership before exposure; return an undo for a failed first-install rename. */
    beforeCommit?: (
      result: InstallResult,
      candidateIdentity: InstalledDirectoryIdentity,
    ) => void | (() => void);
    /** Random journal marker that moves atomically with a first-install candidate. */
    firstInstallMarker?: string;
    /** Existing managed paths; an upgrade must not erase additions outside this set. */
    managedFiles?: string[];
    /** Abort before any filesystem mutation when the caller's desired state changed. */
    beforeMutation?: () => void;
    /** Existing managed directories; omitted for legacy lockfiles that did not track them. */
    managedDirectories?: string[];
    /** Accepted hashes for existing managed files, including either journal snapshot. */
    managedFileHashes?: Record<string, string | string[]>;
    /** Require positive ownership evidence after moving aside an interrupted-removal target. */
    requireVerifiedOwnership?: boolean;
    /** New upgrade recovery identity preclaimed in the lockfile before staging begins. */
    upgradeRecoveryId?: string;
    /** Recovery identity preclaimed before a rejected published candidate can be isolated. */
    rejectionRecoveryId?: string;
    /** Test seam for deterministically exercising restoration races. */
    afterPreviousMove?: () => void;
    /** Test seam for mutation between first exposure and journal reconciliation. */
    afterFirstInstallMove?: (target: string) => void;
    /** Test seam for a target appearing immediately before candidate exposure. */
    beforeCandidateMove?: (target: string) => void;
    /** Test seam for replacing the candidate before its static audit. */
    beforeCandidateAudit?: (candidate: string) => void;
    /** Test seam for replacing the old reservation immediately before the atomic rename. */
    beforeCandidateRename?: (target: string) => void;
    /** Test seam for an addition made after the moved-aside tree passes its audit. */
    afterPreviousAudit?: (previousRoot: string) => void;
    /** Test seam for a mutation after the retained previous tree is audited. */
    afterPreviousRetention?: (previousRoot: string) => void;
  },
): Promise<InstallResult> {
  if (!NAME_PATTERN.test(item.name)) {
    throw new ProvisionError(`Invalid skill name "${item.name}"`, "invalid_item");
  }
  const archiveDir = mkdtempSync(path.join(tmpdir(), "provision-source-"));
  let prepared: PreparedSource;
  try {
    prepared = await prepareSource(item, archiveDir, opts.checkUrl);
  } catch (err) {
    rmSync(archiveDir, { recursive: true, force: true });
    throw err;
  }
  try {
    opts.beforeMutation?.();
  } catch (err) {
    rmSync(archiveDir, { recursive: true, force: true });
    throw err;
  }

  // Staging lives INSIDE skillsDir so the final rename is same-filesystem (atomic),
  // and dot-prefixed so skill loaders scanning the directory skip it.
  mkdirSync(opts.skillsDir, { recursive: true });
  const candidate = path.join(
    opts.skillsDir,
    `.provision-candidate-${randomBytes(16).toString("hex")}`,
  );
  mkdirSync(candidate, { mode: 0o700 });
  const candidateIdentity = directoryIdentity(candidate);
  if (candidateIdentity === null) {
    throw new ProvisionError("Candidate directory identity is unavailable", "untracked_content");
  }
  let staging: string;
  if (opts.upgradeRecoveryId !== undefined) {
    if (!RECOVERY_ID_PATTERN.test(opts.upgradeRecoveryId) || opts.managedFiles === undefined) {
      throw new ProvisionError("Invalid upgrade recovery identity", "invalid_item");
    }
    staging = path.join(opts.skillsDir, `${UPGRADE_RECOVERY_PREFIX}${opts.upgradeRecoveryId}`);
  } else {
    staging = path.join(
      opts.skillsDir,
      `${UPGRADE_RECOVERY_PREFIX}${randomBytes(16).toString("hex")}`,
    );
  }
  if (opts.rejectionRecoveryId !== undefined
    && !RECOVERY_ID_PATTERN.test(opts.rejectionRecoveryId)) {
    throw new ProvisionError("Invalid rejected-candidate recovery identity", "invalid_item");
  }
  let preserveCandidate = false;
  let candidateExposed = false;
  let rejectedCandidateIsolated = false;
  try {
    try {
      execFileSync("tar", [
	prepared.compressed ? "-xzf" : "-xf",
	prepared.archivePath,
	"-C",
	candidate,
	...(prepared.stripWrapper ? ["--strip-components=1"] : []),
      ]);
    } catch {
      throw new ProvisionError("Extraction failed", "archive_rejected");
    }

    // A root `./` entry can overwrite the candidate's mode. Restore access
    // before inspecting the direct sibling that will be atomically exposed.
    opts.beforeCandidateAudit?.(candidate);
    normalizeExtractedModes(candidate);
    const result = auditTree(candidate);
    if (!sameDirectoryIdentity(directoryIdentity(candidate), candidateIdentity)) {
      throw new ProvisionError(
	`Refusing to install "${item.name}" because its candidate directory changed during audit`,
	"untracked_content",
      );
    }
    if (result.files.length === 0) {
      throw new ProvisionError("Archive contains no files", "archive_rejected");
    }

    const target = path.join(opts.skillsDir, item.name);
    const firstInstall = opts.managedFiles === undefined;
    if (firstInstall && targetExists(target)) {
      throw new ProvisionError(
	`Refusing to replace "${item.name}" because the target appeared during installation`,
	"untracked_content",
      );
    }
    if (!firstInstall && hasUntrackedContent(
      target,
      new Set(opts.managedFiles),
      opts.managedDirectories !== undefined ? new Set(opts.managedDirectories) : undefined,
    )) {
      throw new ProvisionError(
	`Refusing to replace "${item.name}" because it contains untracked files`,
	"untracked_content",
      );
    }
    // Persist ownership before either the old or new target moves. First
    // installs recheck after this write and undo the preclaim if exposure fails;
    // upgrades retain their stable+pending recovery journal on swap failures.
    if (firstInstall && opts.firstInstallMarker) {
      writeFileSync(firstInstallMarkerPath(candidate, opts.firstInstallMarker), opts.firstInstallMarker, {
	flag: "wx",
	mode: 0o600,
      });
    }
    const rollbackCommit = opts.beforeCommit?.(result, {
      dev: candidateIdentity.dev.toString(),
      ino: candidateIdentity.ino.toString(),
    });
    if (firstInstall) {
      if (targetExists(target)) {
	rollbackCommit?.();
	throw new ProvisionError(
	  `Refusing to replace "${item.name}" because the target appeared during installation`,
	  "untracked_content",
	);
      }
      try {
	opts.beforeCandidateMove?.(target);
	if (!moveDirectoryNoReplace(
	  candidate,
	  target,
	  () => opts.beforeCandidateRename?.(target),
	)) {
	  preserveCandidate = true;
	  throw new ProvisionError(
	    `Refusing to replace "${item.name}" because the target appeared during installation; candidate preserved at "${candidate}"`,
	    "untracked_content",
	  );
	}
	candidateExposed = true;
	try {
	  assertPublishedCandidate(
	    target,
	    candidateIdentity,
	    item.name,
	    result,
	    opts.firstInstallMarker,
	  );
	} catch (err) {
	  const isolationError = isolateRejectedCandidate(
	    target,
	    item.name,
	    opts.skillsDir,
	    opts.rejectionRecoveryId,
	    { dev: candidateIdentity.dev.toString(), ino: candidateIdentity.ino.toString() },
	  );
	  rejectedCandidateIsolated = true;
	  throw isolationError;
	}
      } catch (err) {
	preserveCandidate = targetExists(candidate);
	// If isolation itself failed, retain the durable ownership journal rather
	// than turning rejected live content into an untracked target.
	if (!candidateExposed || rejectedCandidateIsolated) rollbackCommit?.();
	throw err;
      }
      opts.afterFirstInstallMove?.(target);
      return result;
    }
    // Keep the previous tree as a direct sibling of its target. Both moving it
    // aside and restoring it can then use one atomic no-replace syscall.
    const previous = staging;
    let hadPrevious = false;
    try {
      if (!moveDirectoryNoReplace(target, previous)) {
	throw new ProvisionError(
	  `Upgrade recovery path already exists for "${item.name}"`,
	  "untracked_content",
	);
      }
      hadPrevious = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    opts.afterPreviousMove?.();
    const previousHasUntrackedContent = hadPrevious && hasUntrackedContent(
	previous,
	new Set(opts.managedFiles!),
	opts.managedDirectories !== undefined ? new Set(opts.managedDirectories) : undefined,
    );
    const previousLacksVerifiedOwnership = hadPrevious
      && opts.requireVerifiedOwnership
      && !managedTreeHasVerifiedOwnedFile(
	previous,
	opts.managedFiles!,
	opts.managedFileHashes,
      );
    if (previousHasUntrackedContent || previousLacksVerifiedOwnership) {
      const reason = previousLacksVerifiedOwnership
	? "ownership could not be verified after interrupted removal"
	: "content was added during installation";
      const restored = moveDirectoryNoReplace(previous, target);
      if (!restored) {
	throw new ProvisionError(
	  `Refusing to replace "${item.name}" because ${reason}; prior contents preserved at "${previous}"`,
	  "untracked_content",
	);
      }
      hadPrevious = false;
      throw new ProvisionError(
	`Refusing to replace "${item.name}" because ${reason}`,
	"untracked_content",
      );
    }
    if (hadPrevious) opts.afterPreviousAudit?.(previous);
    try {
      opts.beforeCandidateMove?.(target);

      if (!moveDirectoryNoReplace(
	candidate,
	target,
	() => opts.beforeCandidateRename?.(target),
      )) {
	preserveCandidate = true;
	if (hadPrevious) {
	  throw new ProvisionError(
	    `Upgrade failed because the target was recreated; prior contents preserved at "${previous}" and candidate at "${candidate}"`,
	    "untracked_content",
	  );
	}
	throw new ProvisionError(
	  `Refusing to replace "${item.name}" because the target appeared during installation; candidate preserved at "${candidate}"`,
	  "untracked_content",
	);
      }
      candidateExposed = true;
      try {
	assertPublishedCandidate(target, candidateIdentity, item.name, result);
      } catch (err) {
	isolateRejectedCandidate(
	  target,
	  item.name,
	  opts.skillsDir,
	  opts.rejectionRecoveryId,
	  { dev: candidateIdentity.dev.toString(), ino: candidateIdentity.ino.toString() },
	);
	throw err;
      }
    } catch (err) {
      if (err instanceof ProvisionError && err.code === "untracked_content") throw err;
      preserveCandidate = targetExists(candidate);
      throw err;
    }
    if (hadPrevious) {
      // The staging name is writable by the same UID and cannot stay bound to
      // the audited inode during a post-exposure check. Retain the whole previous
      // tree instead; explicit operator cleanup is the only safe lifecycle.
      const previousAudit = removeManagedTree(previous, {
	files: opts.managedFiles!,
	directories: opts.managedDirectories,
	fileHashes: opts.managedFileHashes,
	afterRootAudit: opts.afterPreviousRetention,
      });
      if (!previousAudit.clean) {
	throw new ProvisionError(
	  `Upgrade completed, but content added during installation was preserved at "${previous}"`,
	  "untracked_content",
	);
      }
    }
    return result;
  } finally {
    try {
      // Once exposed, the candidate pathname is vacant and no longer identifies
      // our audited tree. A same-UID process can reuse it before this finally.
      if (
	!preserveCandidate
	&& !candidateExposed
	&& sameDirectoryIdentity(directoryIdentity(candidate), candidateIdentity)
      ) {
	rmSync(candidate, { recursive: true, force: true });
      }
    } finally {
      rmSync(archiveDir, { recursive: true, force: true });
    }
  }
}

/**
 * Publish a sibling directory without replacing an entry created by another
 * process. Windows rename already refuses an existing directory; POSIX uses
 * renameat2(RENAME_NOREPLACE) or renameatx_np(RENAME_EXCL) through a Node-API
 * helper because no check-then-rename sequence can close this race.
 */
function moveDirectoryNoReplace(
  source: string,
  target: string,
  beforeRename?: () => void,
): boolean {
  if (process.platform === "win32") {
    beforeRename?.();
    try {
      renameSync(source, target);
      return true;
    } catch (err) {
      if (targetExists(target)) return false;
      throw err;
    }
  }
  beforeRename?.();
  return renameDirectoryNoReplace(source, target);
}

function targetExists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function hasUntrackedContent(
  root: string,
  managedFiles: Set<string>,
  managedDirectories?: Set<string>,
): boolean {
  try {
    if (!lstatSync(root).isDirectory()) return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  const walk = (dir: string): boolean => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = lstatSync(full);
      if (stat.isDirectory()) {
	const relative = path.relative(root, full).split(path.sep).join("/");
	if (managedDirectories && !managedDirectories.has(relative)) return true;
	if (walk(full)) return true;
	continue;
      }
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (!stat.isFile() || !managedFiles.has(relative)) return true;
    }
    return false;
  };
  return walk(root);
}

function existsAsDirectory(target: string): boolean {
  try {
    return lstatSync(target).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

interface DirectoryIdentity {
  dev: bigint;
  ino: bigint;
}

function directoryIdentity(target: string): DirectoryIdentity | null {
  try {
    const stat = lstatSync(target, { bigint: true });
    return stat.isDirectory() ? { dev: stat.dev, ino: stat.ino } : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function sameDirectoryIdentity(
  left: DirectoryIdentity | null,
  right: DirectoryIdentity | null,
): boolean {
  return left !== null && right !== null && left.dev === right.dev && left.ino === right.ino;
}

function assertPublishedCandidate(
  target: string,
  expected: DirectoryIdentity,
  itemName: string,
  expectedContents: InstallResult,
  installMarker?: string,
): void {
  const rejectChangedContents = (): never => {
    throw new ProvisionError(
	`Refusing to install "${itemName}" because its candidate contents changed before publication`,
	"untracked_content",
    );
  };
  if (!sameDirectoryIdentity(directoryIdentity(target), expected)) {
    throw new ProvisionError(
      `Refusing to install "${itemName}" because an unaudited candidate reached the target`,
      "untracked_content",
    );
  }
  let publishedContents: InstallResult;
  try {
    // The directory inode can stay stable while a same-UID process mutates its
    // children, so verify the exposed tree before returning its ownership data.
    publishedContents = auditTree(target);
  } catch {
    return rejectChangedContents();
  }
  if (installMarker !== undefined) {
    const marker = `.provision-install-${installMarker}`;
    const markerHash = createHash("sha256").update(installMarker).digest("hex");
    if (publishedContents.fileHashes[marker] !== markerHash) {
      rejectChangedContents();
    }
    publishedContents = {
      files: publishedContents.files.filter((file) => file !== marker),
      directories: publishedContents.directories,
      fileHashes: Object.fromEntries(
	Object.entries(publishedContents.fileHashes).filter(([file]) => file !== marker),
      ),
    };
  }
  if (!sameInstallResult(publishedContents, expectedContents)) {
    rejectChangedContents();
  }
}

export function isolateRejectedCandidate(
  target: string,
  itemName: string,
  skillsDir: string,
  recoveryId?: string,
  expectedIdentity?: InstalledDirectoryIdentity,
): ProvisionError {
  if (!recoveryId) {
    throw new ProvisionError(
      `Rejected candidate for "${itemName}" could not be isolated without a preclaimed recovery`,
      "untracked_content",
    );
  }
  const recovery = path.join(skillsDir, `${REJECTED_RECOVERY_PREFIX}${recoveryId}`);
  const expected = expectedIdentity
    ? { dev: BigInt(expectedIdentity.dev), ino: BigInt(expectedIdentity.ino) }
    : undefined;
  if (expected && !sameDirectoryIdentity(directoryIdentity(target), expected)) {
    throw new ProvisionError(
      `Rejected candidate for "${itemName}" changed identity before isolation; ownership remains recorded`,
      "untracked_content",
    );
  }
  if (!moveDirectoryNoReplace(target, recovery)) {
    throw new ProvisionError(
      `Rejected candidate for "${itemName}" could not be isolated; ownership remains recorded`,
      "untracked_content",
    );
  }
  if (expected && !sameDirectoryIdentity(directoryIdentity(recovery), expected)) {
    // The source pathname was rebound between the check and atomic rename. Put
    // that unrelated tree back when possible and retain the ownership journal.
    moveDirectoryNoReplace(recovery, target);
    throw new ProvisionError(
      `Rejected candidate for "${itemName}" changed identity during isolation; ownership remains recorded`,
      "untracked_content",
    );
  }
  return new ProvisionError(
    `Rejected candidate for "${itemName}" was isolated at "${recovery}"`,
    "untracked_content",
  );
}

function sameInstallResult(left: InstallResult, right: InstallResult): boolean {
  if (left.files.length !== right.files.length || left.directories.length !== right.directories.length) {
    return false;
  }
  const rightDirectories = new Set(right.directories);
  return left.directories.every((directory) => rightDirectories.has(directory))
    && left.files.every((file) =>
      Object.hasOwn(right.fileHashes, file)
      && left.fileHashes[file] === right.fileHashes[file]);
}

function managedTreeHasExactPaths(
  root: string,
  files: string[],
  directories?: string[],
): boolean {
  const expected = new Set<string>();
  for (const relative of files) {
    const parts = managedPathParts(relative);
    if (!parts) return false;
    expected.add(`f:${parts.join("/")}`);
    for (let depth = 1; depth < parts.length; depth += 1) {
      expected.add(`d:${parts.slice(0, depth).join("/")}`);
    }
  }
  for (const relative of directories ?? []) {
    const parts = managedPathParts(relative);
    if (!parts) return false;
    expected.add(`d:${parts.join("/")}`);
    for (let depth = 1; depth < parts.length; depth += 1) {
      expected.add(`d:${parts.slice(0, depth).join("/")}`);
    }
  }

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

function managedTreeHasVerifiedOwnedFile(
  root: string,
  files: string[],
  fileHashes?: Record<string, string | string[]>,
): boolean {
  for (const relative of files) {
    const expected = fileHashes?.[relative];
    if (!expected) continue;
    const file = managedPath(root, relative);
    if (!file) continue;
    try {
      if (!lstatSync(file).isFile()) continue;
      const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
      const accepted = Array.isArray(expected) ? expected : [expected];
      if (accepted.includes(actual)) return true;
    } catch {
      // A concurrent namespace change makes this path unusable as ownership evidence.
    }
  }
  return false;
}

function managedPath(root: string, relative: string): string | null {
  const parts = managedPathParts(relative);
  if (!parts) return null;
  return path.join(root, ...parts);
}

function removeManagedTree(
  root: string,
  opts: {
    files: string[];
    directories?: string[];
    /** Complete path sets that may legitimately own the visible root. */
    rootPathSnapshots?: Array<{ files: string[]; directories?: string[] }>;
    fileHashes?: Record<string, string | string[]>;
    /** Test seam for a namespace mutation after root ownership validation. */
    afterRootAudit?: (root: string) => void;
    /** Test seam for a namespace mutation after the owned root is isolated. */
    afterRootIsolation?: (root: string) => void;
    /** Parent for an explicit-removal recovery; omitted for existing upgrade staging. */
    quarantineParent?: string;
    /** Exact lockfile-owned identity for this recovery directory. */
    recoveryId?: string;
  },
): { clean: boolean; recoveryPath?: string } {
  if (!existsAsDirectory(root)) return { clean: !targetExists(root) };

  // Capture identity before walking the tree. A complete path-set check alone
  // cannot authorize a later rmdir by pathname because the name may be swapped
  // to a different directory while cleanup is in progress.
  const auditedRootIdentity = directoryIdentity(root);

  // An unresolved upgrade journal can outlive a lost exposure race. In that
  // case the visible target may belong to the racing process. Never infer
  // ownership of an otherwise-empty root from the journal alone.
  const rootPathSnapshots = opts.rootPathSnapshots ?? [{
    files: opts.files,
    directories: opts.directories,
  }];
  const rootWasCompleteOwnedTree = rootPathSnapshots.some((snapshot) =>
    managedTreeHasExactPaths(root, snapshot.files, snapshot.directories));
  const rootHasVerifiedOwnedFile = managedTreeHasVerifiedOwnedFile(
    root,
    opts.files,
    opts.fileHashes,
  );

  // Upgrade staging is already hidden and lockfile-owned. Retain it whole:
  // any pathname cleanup would let a same-UID sibling swap redirect deletion.
  if (!opts.quarantineParent || !opts.recoveryId) {
    opts.afterRootAudit?.(root);
    return { clean: rootWasCompleteOwnedTree, recoveryPath: root };
  }

  // A visible target with no hash-verified owned file may have been recreated
  // after an earlier process isolated the managed tree but crashed before
  // clearing its journal. Matching path names and types alone are not proof of
  // ownership, so leave that target untouched.
  if (!rootHasVerifiedOwnedFile) {
    return { clean: true };
  }

  if (!auditedRootIdentity) return { clean: false };
  opts.afterRootAudit?.(root);
  const recoveryPath = path.join(
    opts.quarantineParent,
    `${REMOVAL_RECOVERY_PREFIX}${opts.recoveryId}`,
  );
  if (!moveDirectoryNoReplace(root, recoveryPath)) {
    throw new ProvisionError(
      `Removal could not isolate "${path.basename(root)}" without replacing another entry`,
      "untracked_content",
    );
  }
  if (!sameDirectoryIdentity(auditedRootIdentity, directoryIdentity(recoveryPath))) {
    if (!moveDirectoryNoReplace(recoveryPath, root)) {
      throw new ProvisionError(
	`Removal stopped after the target changed; replacement preserved at "${recoveryPath}"`,
	"untracked_content",
      );
    }
    return { clean: false };
  }
  opts.afterRootIsolation?.(recoveryPath);
  // Never traverse the writable recovery pathname after isolation. Retaining
  // the complete inode tree is what keeps both late writes and sibling swaps
  // recoverable until an operator explicitly removes it.
  return { clean: true, recoveryPath };
}

/** Isolate a journal-owned skill tree for explicit operator cleanup. */
export function removeSkill(
  name: string,
  opts: {
    skillsDir: string;
    files: string[];
    directories?: string[];
    rootPathSnapshots?: Array<{ files: string[]; directories?: string[] }>;
    fileHashes?: Record<string, string | string[]>;
    /** Test seam for a namespace mutation after root ownership validation. */
    afterRootAudit?: (root: string) => void;
    /** Test seam for a namespace mutation after the owned root is isolated. */
    afterRootIsolation?: (root: string) => void;
    /** New identity preclaimed in the lockfile before this removal begins. */
    recoveryId?: string;
  },
): { recoveryPath?: string } {
  if (!LEGACY_NAME_PATTERN.test(name)) {
    throw new ProvisionError(`Invalid skill name "${name}"`, "invalid_item");
  }
  const recoveryId = opts.recoveryId ?? randomBytes(16).toString("hex");
  if (!RECOVERY_ID_PATTERN.test(recoveryId)) {
    throw new ProvisionError("Invalid recovery identity", "invalid_item");
  }
  const result = removeManagedTree(path.join(opts.skillsDir, name), {
    ...opts,
    quarantineParent: opts.skillsDir,
    recoveryId,
  });
  return { recoveryPath: result.recoveryPath };
}
