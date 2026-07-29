#!/usr/bin/env node
// Publishing runs from the working tree, so .gitignore does not protect the npm
// tarball: the `files` allowlist overrides it. Anything git refuses to track is
// scratch, and scratch must never reach the registry.
// Invariant: every packed file is git-tracked, except generated build output.

import { execFileSync } from 'node:child_process';

const GENERATED_PREFIXES = ['dist/'];

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packed = JSON.parse(run(npm, ['pack', '--dry-run', '--json']))[0].files.map((f) => f.path);
const tracked = new Set(run('git', ['ls-files']).split('\n').filter(Boolean));

const leaked = packed.filter(
  (p) => !GENERATED_PREFIXES.some((prefix) => p.startsWith(prefix)) && !tracked.has(p),
);

if (leaked.length > 0) {
  console.error('Refusing to publish: untracked files would ship in the npm package.\n');
  for (const path of leaked) console.error(`  ${path}`);
  console.error('\nRemove them, commit them, or exclude them via "files" in package.json.');
  process.exit(1);
}

console.log(`Package contents OK — ${packed.length} files, all tracked or generated.`);
