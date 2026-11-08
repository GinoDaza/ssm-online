/** Emulator WRAM dumps made by tools/oracle/dump.py (local, git-ignored). */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RomImage, type CpuSnapshot, type PpuMemories } from '../src/index.ts';

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
  /** CPU state of record k (dumps made since the dump recorded it) */
  cpu(k: number): CpuSnapshot | undefined;
  /** PPU memories of record 0 and the emulator's picture of frame k (1..frames), dumps made with --video */
  ppu: PpuMemories | undefined;
  picture(k: number): Uint16Array | undefined;
}

type CpuJson = Omit<CpuSnapshot, 'io'> & { io: string };

export function hasFixture(name: string): boolean {
  return existsSync(resolve(ROOT, 'fixtures', name + '.wram'));
}

/** The dump also recorded the PPU state and the emulator's pictures (dump.py --video). */
export function hasPicture(name: string): boolean {
  return hasFixture(name) && existsSync(resolve(ROOT, 'fixtures', name + '.video'));
}

export function loadFixture(name: string): Fixture {
  const base = resolve(ROOT, 'fixtures', name);
  const meta = JSON.parse(readFileSync(base + '.json', 'utf8')) as {
    start: number;
    frames: number;
    record: number;
    pads: string[];
    cpu?: CpuJson[];
  };
  const data = new Uint8Array(readFileSync(base + '.wram'));
  const ppuBlob = existsSync(base + '.ppu') ? new Uint8Array(readFileSync(base + '.ppu')) : undefined;
  const video = existsSync(base + '.video') ? new Uint8Array(readFileSync(base + '.video')) : undefined;
  const PICTURE = 256 * 224;
  return {
    start: meta.start,
    frames: meta.frames,
    pads: meta.pads,
    record: (k) => data.subarray(k * meta.record, (k + 1) * meta.record),
    ppu: ppuBlob && {
      vram: ppuBlob.subarray(0, 0x10000),
      cgram: ppuBlob.subarray(0x10000, 0x10200),
      oam: ppuBlob.subarray(0x10200, 0x10420),
      regs: ppuBlob.subarray(0x10420, 0x10520),
    },
    picture: (k) => video && new Uint16Array(video.buffer, video.byteOffset + (k - 1) * 2 * PICTURE, PICTURE),
    cpu: (k) => {
      const c = meta.cpu?.[k];
      return c && { ...c, io: Uint8Array.from(Buffer.from(c.io, 'hex')) };
    },
  };
}
