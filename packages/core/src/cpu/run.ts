/**
 * The dispatcher: runs translated blocks, or a hand-written override where one is registered
 * at an address. An override replaces the routine entered at that address and must leave the
 * machine as the routine's return would (use `rts` / `rtl`).
 */
import type { Machine } from './machine.ts';
import { Translator } from './compile.ts';

/** Hand port of the routine at an address; returns the next pc. */
export type Override = (c: Machine) => number;

export class Runner {
  readonly translator = new Translator();
  readonly overrides = new Map<number, Override>();
  /** blocks executed (statistics) */
  steps = 0;
  /** blocks executed by the last run() */
  lastBlocks = 0;

  /** Run from pc until pc === stop (or WAI); returns the pc reached. */
  run(c: Machine, pc: number, stop: number, maxSteps = 5_000_000): number {
    const ov = this.overrides;
    const tr = this.translator;
    let n = 0;
    while (pc !== stop) {
      c.pb = pc >>> 16;
      c.blockPc = pc;
      const o = ov.get(pc);
      pc = o !== undefined ? o(c) : tr.get(c, pc)(c);
      if (c.waiting) break;
      if (++n > maxSteps) throw new Error(`no return after ${maxSteps} blocks (pc ${pc.toString(16)})`);
    }
    this.steps += n;
    this.lastBlocks = n;
    return pc;
  }

  /**
   * Call the routine at `entry` as JSR (bank-local, RTS) or JSL (RTL) would, and run it to its
   * return. Uses a sentinel return address that no game code occupies.
   */
  call(c: Machine, entry: number, kind: 'jsr' | 'jsl'): void {
    const bank = entry & 0xff0000;
    const stop = kind === 'jsr' ? bank | 0xffff : 0xffffff;
    if (kind === 'jsl') c.push8(0xff);
    c.push16(0xfffe);
    this.run(c, entry, stop);
  }
}

/** Return of a JSR-called override. */
export function rts(c: Machine): number {
  return (c.pb << 16) | ((c.pull16() + 1) & 0xffff);
}

/** Return of a JSL-called override. */
export function rtl(c: Machine): number {
  const lo = c.pull16();
  const b = c.pull8();
  return (b << 16) | ((lo + 1) & 0xffff);
}
