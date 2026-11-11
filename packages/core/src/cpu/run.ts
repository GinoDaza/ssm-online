/**
 * The dispatcher: runs translated blocks, or a hand-written override where one is registered
 * at an address. An override replaces the routine entered at that address and must leave the
 * machine as the routine's return would (use `rts` / `rtl`). Its bus accesses spend time like
 * the original's; fetches and internal cycles it should charge with `c.tick` (an override that
 * spends less time than the original moves later IRQs earlier in the code, deterministically).
 *
 * An override may sit inside a routine (a branch target, or the middle of straight code):
 * register it with override(), and translated blocks end before its address, so execution
 * always reaches it through the dispatcher.
 */
import type { Machine } from './machine.ts';
import { Translator } from './compile.ts';
import { NEVER } from './timing.ts';

/** Hand port of the routine at an address; returns the next pc. */
export type Override = (c: Machine) => number;

export class Runner {
  readonly translator = new Translator();
  readonly overrides = new Map<number, Override>();
  /** addresses where translated blocks end without an override (see split) */
  private readonly splits = new Set<number>();

  constructor() {
    this.translator.stops = { has: (pc) => this.overrides.has(pc) || this.splits.has(pc) };
  }

  /** End translated blocks at `pc` too, so an override can run the code before it on its own. */
  split(pc: number): void {
    this.splits.add(pc);
    this.translator.clear();
  }

  /**
   * Run the original code at `pc` up to the next block end (an override or a split), as the
   * translation would: for overrides that wrap one original instruction.
   */
  original(c: Machine, pc: number): number {
    return this.translator.get(c, pc)(c);
  }

  /**
   * Run `fn` instead of the code at `pc` (null: the original again). An address takes one
   * override: registering a second throws, so two changes never replace each other silently
   * (remove the first with null to replace it on purpose).
   */
  override(pc: number, fn: Override | null): void {
    if (fn && this.overrides.has(pc)) throw new Error(`override at ${pc.toString(16).toUpperCase()} already registered`);
    if (fn) this.overrides.set(pc, fn);
    else this.overrides.delete(pc);
    this.translator.clear();
  }
  /** blocks executed (statistics) */
  steps = 0;
  /** blocks executed by the last run() */
  lastBlocks = 0;

  /** Run one block (or override) at pc; returns the next pc. */
  block(c: Machine, pc: number): number {
    c.pb = pc >>> 16;
    c.blockPc = pc;
    this.steps++;
    const o = this.overrides.get(pc);
    return o !== undefined ? o(c) : this.translator.get(c, pc)(c);
  }

  /**
   * Run from pc until pc === stop (or WAI); returns the pc reached. No interrupts: for calling
   * single routines (tests, tools). The game itself runs in Game.step.
   */
  run(c: Machine, pc: number, stop: number, maxSteps = 5_000_000): number {
    const ov = this.overrides;
    const tr = this.translator;
    let n = 0;
    while (pc !== stop) {
      c.pb = pc >>> 16;
      c.blockPc = pc;
      c.brk = NEVER;
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
