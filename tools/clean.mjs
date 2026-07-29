#!/usr/bin/env node
// `build` depends on this, so it must run wherever npm runs. npm executes scripts
// through cmd.exe on Windows, where `rm` does not exist.

import { rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
