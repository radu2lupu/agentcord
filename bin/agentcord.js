#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cli = join(__dirname, '..', 'src', 'cli.ts');
const args = process.argv.slice(2);

const child = spawn(
  process.execPath,
  ['--experimental-strip-types', cli, ...args],
  {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  },
);

child.on('exit', (code) => process.exit(code ?? 0));
