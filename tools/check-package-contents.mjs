#!/usr/bin/env node
// Publishing runs from the working tree, so .gitignore does not protect the npm
// tarball: the `files` allowlist overrides it. Anything git refuses to track is
// scratch, and scratch must never reach the registry.
// Invariant: every packed file is git-tracked, or is a build artifact that maps
// back to a tracked TypeScript source. `dist/` is gitignored and shipped whole,
// so exempting the prefix would let anything dropped there ride along.

import { execFileSync } from 'node:child_process';

const OUT_DIR = 'dist/';
const SRC_DIR = 'src/';
// Longest first: `.d.ts.map` must not be truncated by the `.d.ts` rule.
const EMIT_SUFFIXES = ['.d.ts.map', '.d.ts', '.js.map', '.js'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
}

// A build artifact is legitimate only if tsc could have emitted it from a source
// file we actually track.
function isEmittedFromTrackedSource(packedPath, tracked) {
  const rest = packedPath.slice(OUT_DIR.length);
  const suffix = EMIT_SUFFIXES.find((s) => rest.endsWith(s));
  if (!suffix) return false;
  const stem = SRC_DIR + rest.slice(0, -suffix.length);
  return SOURCE_EXTENSIONS.some((ext) => tracked.has(stem + ext));
}

// npm is `npm.cmd` on Windows, and Node refuses to execFile a .cmd without a shell.
const isWindows = process.platform === 'win32';
const packed = JSON.parse(
  run(isWindows ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json'], { shell: isWindows }),
)[0].files.map((f) => f.path);
const tracked = new Set(run('git', ['ls-files']).split('\n').filter(Boolean));

const leaked = packed.filter((p) => {
  if (tracked.has(p)) return false;
  if (!p.startsWith(OUT_DIR)) return true;
  return !isEmittedFromTrackedSource(p, tracked);
});

if (leaked.length > 0) {
  console.error('Refusing to publish: files that are neither tracked nor build output would ship.\n');
  for (const path of leaked) console.error(`  ${path}`);
  console.error(
    '\nRemove them, commit them, or exclude them via "files" in package.json.\n' +
      `Files under ${OUT_DIR} must be emitted from a tracked ${SRC_DIR} source — run "npm run build" to refresh.`,
  );
  process.exit(1);
}

const generated = packed.filter((p) => !tracked.has(p)).length;
console.log(
  `Package contents OK — ${packed.length} files (${packed.length - generated} tracked, ${generated} build output).`,
);
