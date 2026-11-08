/** Emulator WRAM dumps made by tools/oracle/dump.py (local, git-ignored). */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RomImage } from '../src/index.ts';

export const ROOT = resolve(import.meta.dirname, '../../..');
export const ROM_PATH = resolve(ROOT, 'roms/Saturday Night Slam Masters (USA).sfc');

let rom: RomImage | null = null;

export function haveRom(): boolean {
  return existsSync(ROM_PATH);
}

export function loadRom(): RomImage {
  rom ??= new RomImage(new Uint8Array(readFileSync(ROM_PATH)));
  return rom;
}

export interface Fixture {
  start: number;
  frames: number;
  pads: string[];
  /** record k = WRAM before frame start + k */
  record(k: number): Uint8Array;
}

export function hasFixture(name: string): boolean {
  return existsSync(resolve(ROOT, 'fixtures', name + '.wram'));
}

export function loadFixture(name: string): Fixture {
  const base = resolve(ROOT, 'fixtures', name);
  const meta = JSON.parse(readFileSync(base + '.json', 'utf8')) as { start: number; frames: number; record: number; pads: string[] };
  const data = new Uint8Array(readFileSync(base + '.wram'));
  return {
    start: meta.start,
    frames: meta.frames,
    pads: meta.pads,
    record: (k) => data.subarray(k * meta.record, (k + 1) * meta.record),
  };
}
