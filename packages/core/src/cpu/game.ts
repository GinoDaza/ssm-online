/**
 * The whole game: power-on, then one call per video frame. The main loop waits in its
 * scheduler (C000F8: STZ $EC; WAI; LDA $EC; BEQ) until the video IRQ (C0023A, vector 00:FFEE)
 * releases it. No cycle timing yet: IRQs run between main-loop passes, never inside one.
 */
import type { RomImage } from '../rom.ts';
import { Machine } from './machine.ts';
import { Runner } from './run.ts';

const RESET = 0x00ffa0;
const IRQ_VECTOR = 0x00ffee;
const MAX_IRQS_PER_FRAME = 4;
/** the instruction after the scheduler's WAI (C00102) */
const SCHEDULER_WAKE = 0xc00103;

export class Game {
  readonly m: Machine;
  readonly runner = new Runner();
  /** where the main loop waits (the pc after its WAI) */
  private resume = 0;
  frame = 0;

  constructor(rom: RomImage) {
    this.m = new Machine(rom);
  }

  powerOn(): void {
    const m = this.m;
    m.wram.fill(0x55); // power-on WRAM pattern of snes9x (the oracle); the game clears what it uses
    m.e = true;
    m.setP(0x34);
    m.s = 0x01ff;
    m.d = 0;
    m.db = 0;
    m.ioreg[0x1f0] = 0; // APU in its IPL
    this.resume = this.runMain(RESET);
  }

  /**
   * Start from a WRAM image taken between two frames (the oracle's dumps): the main loop is then
   * waiting in the scheduler (stack reset to $02FF, D = 0, DB = 80, 8-bit registers), the APU
   * driver is running.
   */
  seed(wram: Uint8Array): void {
    const m = this.m;
    m.wram.set(wram);
    m.e = false;
    m.setP(0x30);
    m.s = 0x02ff;
    m.d = 0;
    m.db = 0x80;
    m.x = 0xff;
    m.ioreg[0x1f0] = 2;
    m.ioreg[0x1f2] = 0;
    this.resume = SCHEDULER_WAKE;
  }

  /** Run main code from pc until it waits (WAI); returns the resume pc. */
  private runMain(pc: number): number {
    const m = this.m;
    m.waiting = false;
    const at = this.runner.run(m, pc, -1);
    if (!m.waiting) throw new Error(`main loop stopped at ${at.toString(16)} without WAI`);
    return at;
  }

  /** Take the IRQ: push PB, PC, P (native), I set, D clear; run to its RTI. */
  private irq(): void {
    const m = this.m;
    m.push8(this.resume >>> 16);
    m.push16(this.resume & 0xffff);
    m.push8(m.p);
    m.i = true;
    m.dec = false;
    m.waiting = false;
    const handler = m.read16z(IRQ_VECTOR);
    const back = this.runner.run(m, handler, this.resume);
    if (back !== this.resume) throw new Error(`IRQ returned to ${back.toString(16)}`);
  }

  /**
   * One video frame with these pad words (SNES layout, pads 1-4). A frame ends just before the
   * IRQ that will release the scheduler (phase EF = 0), which is where the oracle's frame
   * boundary falls: [phase-0 IRQ: uploads, release] [main loop to its WAI] [other phases
   * (split screen, controller acquisition) while the main loop waits].
   */
  step(pads: ArrayLike<number>): void {
    const m = this.m;
    for (let k = 0; k < 4; k++) m.pads[k] = pads[k] ?? 0;
    m.autoJoypad();
    if (m.sound !== null) m.sound.length = 0;
    let released = false;
    for (let k = 0; ; k++) {
      if (k === MAX_IRQS_PER_FRAME) throw new Error(`frame ${this.frame}: main loop never left its wait`);
      if (released && m.wram[0xef] === 0) break; // the next IRQ releases: next frame's
      this.irq();
      if (m.wram[0xec] !== 0) released = true;
      this.resume = this.runMain(this.resume);
    }
    this.frame++;
  }
}
