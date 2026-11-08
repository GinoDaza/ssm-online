import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROM_SHA1 } from '@ssm/core';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The ROM dump named by SSM_ROM (default roms/...), checked against the expected SHA-1. */
export function loadRomFile(): Buffer {
  const path = resolve(REPO_ROOT, process.env['SSM_ROM'] ?? 'roms/Saturday Night Slam Masters (USA).sfc');
  if (!existsSync(path)) throw new Error(`ROM not found at ${path} (see roms/README.md)`);
  const bytes = readFileSync(path);
  const sha = createHash('sha1').update(bytes).digest('hex');
  if (sha !== ROM_SHA1) throw new Error(`ROM SHA-1 ${sha}, expected ${ROM_SHA1} (USA, no header)`);
  return bytes;
}
