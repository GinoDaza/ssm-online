/**
 * The whole game: power-on, then one call per video frame. Execution is one continuous
 * stream, as on hardware: the main loop, and the video IRQ (C0023A, vector 00:FFEE) wherever
 * its H/V timer position falls in it. A frame ends at the first instruction boundary after
 * line 225 (vertical blank) begins, which is where the oracle's frame ends too; that boundary
 * can fall inside the IRQ handler or inside a long DMA.
 *
 * In a match the IRQ runs twice a frame: line 215 (EF = 0: uploads, releases the main loop's
 * scheduler at C000F8) and line 31 (EF = 2: controller acquisition), which lands inside the
 * main loop. Other screens use one IRQ at line 224.
 */
import type { RomImage } from '../rom.ts';
import { IChange, Machine, PpuReg } from './machine.ts';
import { Runner } from './run.ts';
import { hEvent, updateIrq } from './timing.ts';

const RESET = 0x00ffa0;
const IRQ_VECTOR = 0x00ffee;
/** blocks per frame before the game is considered stuck */
const MAX_BLOCKS = 2_000_000;

/** CPU, timing and DMA state at a frame boundary of the oracle (tools/oracle/dump.py). */
export interface CpuSnapshot {
  pb: number;
  db: number;
  p: number;
  e: number;
  a: number;
  d: number;
  s: number;
  x: number;
  y: number;
  pc: number;
  /** clocks into the line, line */
  h: number;
  v: number;
  hMax: number;
  event: number;
  nextEvent: number;
  refresh: number;
  waiting: number;
  irqLine: number;
  nextIrq: number;
  /** pending I-flag change of CLI / SEI (snes9x: 1 set, 2 clear) */
  flagChange: number;
  field: number;
  /** WRAM port address ($2181-$2183) */
  wram: number;
  /** $4200-$421F */
  io: Uint8Array;
  /** per channel: $43x0-$43xA, then repeat | transfer << 1 */
  dma: number[][];
  /** the PPU's latched registers (dumps made with --video) */
  ppu?: {
    hofs: number[];
    vofs: number[];
    ofsLatch: number;
    m7a: number;
    m7b: number;
    m7Latch: number;
    fixed: number[];
    brightness: number;
  };
}

/** PPU memories at a frame boundary of the oracle: VRAM, CGRAM, OAM, registers $2100-$21FF. */
export interface PpuMemories {
  vram: Uint8Array;
  cgram: Uint8Array;
  oam: Uint8Array;
  regs: Uint8Array;
}

export class Game {
  readonly m: Machine;
  readonly runner = new Runner();

  constructor(rom: RomImage) {
    this.m = new Machine(rom);
  }

  /** frames completed */
  get frame(): number {
    return this.m.frames;
  }

  powerOn(): void {
    const m = this.m;
    m.wram.fill(0x55); // power-on WRAM pattern of snes9x (the oracle); the game clears what it uses
    m.resetTiming();
    m.e = true;
    m.setP(0x34);
    m.s = 0x01ff;
    m.d = 0;
    m.db = 0;
    m.ioreg[0x1f0] = 0; // APU in its IPL
    m.pc = RESET;
  }

  /**
   * Start from a frame boundary of the oracle: its WRAM and CPU state (the APU driver is
   * running, as in any state the dumps are taken from).
   */
  seed(wram: Uint8Array, cpu: CpuSnapshot, ppu?: PpuMemories): void {
    const m = this.m;
    m.wram.set(wram);
    if (ppu && cpu.ppu) {
      m.vram.set(ppu.vram);
      m.cgram.set(ppu.cgram);
      m.oam.set(ppu.oam);
      m.ioreg.set(ppu.regs.subarray(0, 0x40)); // PPU registers ($2140+ are the APU stand-in's)
      const r = cpu.ppu;
      for (let n = 0; n < 4; n++) {
        m.ppu[PpuReg.HOFS + n] = r.hofs[n]!;
        m.ppu[PpuReg.VOFS + n] = r.vofs[n]!;
      }
      m.ppu[PpuReg.OFS_LATCH] = r.ofsLatch;
      m.ppu[PpuReg.M7A] = r.m7a;
      m.ppu[PpuReg.M7B] = r.m7b;
      m.ppu[PpuReg.M7_LATCH] = r.m7Latch;
      m.ppu[PpuReg.FIXED_R] = r.fixed[0]!;
      m.ppu[PpuReg.FIXED_G] = r.fixed[1]!;
      m.ppu[PpuReg.FIXED_B] = r.fixed[2]!;
      m.ppu[PpuReg.MAX_BRIGHTNESS] = r.brightness;
    }
    m.resetTiming();
    m.e = cpu.e !== 0;
    m.setP(cpu.p);
    m.a = cpu.a;
    m.x = cpu.x;
    m.y = cpu.y;
    m.s = cpu.s;
    m.d = cpu.d;
    m.db = cpu.db;
    m.pc = (cpu.pb << 16) | cpu.pc;
    m.cyc = cpu.h;
    m.vline = cpu.v;
    m.hMax = cpu.hMax;
    m.event = cpu.event;
    m.hNext = cpu.nextEvent;
    m.refresh = cpu.refresh;
    m.field = cpu.field;
    m.waiting = cpu.waiting !== 0;
    m.irqLine = cpu.irqLine !== 0;
    m.irqAt = cpu.nextIrq;
    m.iChange = cpu.flagChange & 2 ? IChange.Clear : cpu.flagChange & 1 ? IChange.Set : IChange.None;
    m.wmaddr = cpu.wram & 0x1ffff;
    m.ioreg.set(cpu.io, 0x200);
    m.fast = cpu.io[0x0d]! & 1 ? 6 : 8;
    m.nmiFlag = cpu.v >= 225 ? 0x80 : 0;
    cpu.dma.forEach((ch, k) => {
      m.ioreg.set(ch.slice(0, 11), 0x300 + 16 * k);
      m.ioreg[0x1e0 + k] = ch[11]!;
    });
    m.ioreg[0x1f0] = 2; // APU driver running
    m.ioreg[0x1f2] = 0;
    m.ioreg[0x1f4] = 16; // serial reads after the auto-read
    m.ioreg[0x1f5] = 16;
  }

  /** Take the IRQ (native mode): push PB, PC, P; I set, D clear; jump through 00:FFEE. */
  private interrupt(): void {
    const m = this.m;
    if (m.e) throw new Error(`IRQ in emulation mode at ${m.pc.toString(16)} (not used by the game)`);
    m.tick(m.speed(m.pc) + 6); // the opcode fetch it replaces, and an internal cycle
    m.push8(m.pc >>> 16);
    m.push16(m.pc & 0xffff);
    m.push8(m.p);
    m.dec = false;
    m.i = true;
    m.pc = m.read16(IRQ_VECTOR);
  }

  /** WAI: let time pass, 6 clocks at a time, up to the next line event or the IRQ. */
  private idle(): void {
    const m = this.m;
    const until = Math.min(m.irqAt, m.hNext);
    m.cyc += until > m.cyc ? 6 * Math.trunc((until - m.cyc + 5) / 6) : 6;
    while (m.cyc >= m.hNext) hEvent(m);
  }

  /** One video frame with these pad words (SNES layout, pads 1-4), read on line 227. */
  step(pads: ArrayLike<number>): void {
    const m = this.m;
    const runner = this.runner;
    for (let k = 0; k < 4; k++) m.pads[k] = pads[k] ?? 0;
    if (m.sound !== null) m.sound.length = 0;
    m.frameDone = false;
    for (let n = 0; ; n++) {
      // an instruction boundary, in the oracle's order: timer, IRQ, I-flag change, frame end
      m.brk = m.irqAt;
      if (m.cyc >= m.irqAt) {
        updateIrq(m, false);
        m.irqLine = true;
      }
      if (m.irqLine) {
        if (m.waiting) {
          m.waiting = false;
          m.tick(18);
        }
        if (!m.i) {
          m.applyIChange(); // the pushed P holds the new flag
          this.interrupt();
        }
      }
      m.applyIChange();
      if (m.frameDone) break;
      if (m.irqLine && !m.i) m.stop(); // after a CLI: one more instruction, then the IRQ
      if (m.waiting) {
        this.idle();
        continue;
      }
      m.pc = runner.block(m, m.pc);
      if (n > MAX_BLOCKS) throw new Error(`frame ${m.frames}: stuck at ${m.pc.toString(16)}`);
    }
    m.frames++;
  }
}
