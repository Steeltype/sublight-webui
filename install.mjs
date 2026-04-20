#!/usr/bin/env node
// Cross-platform install dispatcher. Picks the right platform-specific
// installer and forwards stdio so the user sees its output directly.
// Invoked via `npm run install-sublight`.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const platformCommand = () => {
  switch (process.platform) {
    case 'win32':
      return ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'install.ps1')]];
    case 'linux':
    case 'darwin':
      return ['bash', [join(here, 'install.sh')]];
    default:
      console.error(`Sublight installer does not support platform "${process.platform}". Supported: win32, linux, darwin.`);
      process.exit(1);
  }
};

const [cmd, args] = platformCommand();
const result = spawnSync(cmd, args, { stdio: 'inherit', cwd: here });
process.exit(result.status ?? 1);
