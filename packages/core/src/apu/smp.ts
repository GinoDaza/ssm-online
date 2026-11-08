/**
 * The S-SMP (SPC700) of the sound unit, ported from the snes9x core the oracle runs
 * (apu/bapu/smp: bsnes's "oppseudo" core). Instructions run whole, except the ones split into
 * steps (`OC`), which can pause between two bus cycles when the CPU catches it up, as in the
 * oracle. Every bus cycle is one SPC clock: it ticks the three timers and the DSP's clock.
 *
 * All state is in typed arrays over the Machine's state buffer (`Apu`): stores wrap to the
 * register width as the C++ does, and a snapshot is a copy. The opcode bodies below are a
 * mechanical translation of the snes9x source; keep them that way.
 */
import type { Dsp } from './dsp.ts';

/** 8-bit registers (r): A, X, Y, SP, the PSW flags, the step state, MMIO and timers. */
export const A = 0, X = 1, Y = 2, S = 3;
export const FN = 4, FV = 5, FP = 6, FB = 7, FH = 8, FI = 9, FZ = 10, FC = 11;
/** opcode being run and its step (0: at an instruction boundary) */
export const ON = 12, OC = 13;
/** $F1 bit 7, $F2, $F8, $F9 */
export const IPL = 14, DSP_ADDR = 15, F8 = 16, F9 = 17;
/** timer k: enable, target, stage 1-3 ticks at T0 + 5 k */
export const T0 = 18;
/** what the CPU wrote to $2140-$2143 (the SMP reads them at $F4-$F7) */
export const CPU_PORT = 33;
export const R8_SIZE = 40;
/** 16-bit registers (w): PC and the operand temporaries of the C++ core */
export const PC = 0, RD = 1, WR = 2, DP = 3, SP = 4, YA = 5, BIT = 6;
export const R16_SIZE = 8;

const IPL_ROM = [
  0xcd, 0xef, 0xbd, 0xe8, 0x00, 0xc6, 0x1d, 0xd0, 0xfc, 0x8f, 0xaa, 0xf4, 0x8f, 0xbb, 0xf5, 0x78,
  0xcc, 0xf4, 0xd0, 0xfb, 0x2f, 0x19, 0xeb, 0xf4, 0xd0, 0xfc, 0x7e, 0xf4, 0xd0, 0x0b, 0xe4, 0xf5,
  0xcb, 0xf4, 0xd7, 0x00, 0xfc, 0xd0, 0xf3, 0xab, 0x01, 0x10, 0xef, 0x7e, 0xf4, 0x10, 0xeb, 0xba,
  0xf6, 0xda, 0x00, 0xba, 0xf4, 0xc4, 0xf4, 0xdd, 0x5d, 0xd0, 0xdb, 0x1f, 0x00, 0x00, 0xc0, 0xff,
];

export class Smp {
  readonly ram: Uint8Array;
  readonly r: Uint8Array;
  readonly w: Uint16Array;
  /** t[0]: clocks the SMP is behind the CPU (it runs while negative) */
  readonly t: Int32Array;
  readonly dsp: Dsp;

  constructor(ram: Uint8Array, r: Uint8Array, w: Uint16Array, t: Int32Array, dsp: Dsp) {
    this.ram = ram;
    this.r = r;
    this.w = w;
    this.t = t;
    this.dsp = dsp;
  }

  get clock(): number {
    return this.t[0]!;
  }

  set clock(v: number) {
    this.t[0] = v;
  }

  /** Power-on: RAM cleared, the IPL ROM at $FFC0. */
  reset(): void {
    const r = this.r;
    this.ram.fill(0);
    r.fill(0);
    this.w.fill(0);
    this.clock = 0;
    this.w[PC] = 0xffc0;
    r[S] = 0xef;
    this.setP(0x02);
    r[IPL] = 1;
  }

  /** Run until the SMP has caught up with the CPU. */
  enter(): void {
    while (this.t[0]! < 0) this.step();
  }

  // ---- CPU side ----------------------------------------------------------------------------

  /** $2140-$2143 as the CPU reads them: what the SMP wrote to $F4-$F7. */
  portRead(port: number): number {
    return this.ram[0xf4 + (port & 3)]!;
  }

  portWrite(port: number, v: number): void {
    this.r[CPU_PORT + (port & 3)] = v;
  }

  // ---- registers ---------------------------------------------------------------------------

  ya(): number {
    return this.r[A]! | (this.r[Y]! << 8);
  }

  setYA(v: number): void {
    this.r[A] = v;
    this.r[Y] = v >> 8;
  }

  getP(): number {
    const r = this.r;
    return (r[FN]! << 7) | (r[FV]! << 6) | (r[FP]! << 5) | (r[FB]! << 4) | (r[FH]! << 3) | (r[FI]! << 2) | (r[FZ]! << 1) | r[FC]!;
  }

  setP(p: number): void {
    const r = this.r;
    for (let k = 0; k < 8; k++) r[FC - k] = (p >> k) & 1;
  }

  // ---- clocks and timers -------------------------------------------------------------------

  private timer(k: number, clocks: number, freq: number): void {
    const r = this.r;
    const b = T0 + 5 * k;
    r[b + 2] = r[b + 2]! + clocks;
    if (r[b + 2]! < freq) return;
    r[b + 2] = r[b + 2]! - freq;
    if (!r[b]) return;
    r[b + 3] = r[b + 3]! + 1;
    if (r[b + 3] !== r[b + 1]) return;
    r[b + 3] = 0;
    r[b + 4] = (r[b + 4]! + 1) & 15;
  }

  private tick(clocks: number): void {
    this.timer(0, clocks, 128);
    this.timer(1, clocks, 128);
    this.timer(2, clocks, 16);
    this.t[0] = this.t[0]! + clocks;
    this.dsp.clock += clocks;
  }

  // ---- bus ---------------------------------------------------------------------------------

  private mmioRead(addr: number): number {
    const r = this.r;
    switch (addr) {
      case 0xf2:
        return r[DSP_ADDR]!;
      case 0xf3:
        return this.dsp.read(r[DSP_ADDR]! & 0x7f);
      case 0xf4:
      case 0xf5:
      case 0xf6:
      case 0xf7:
        return r[CPU_PORT + (addr & 3)]!;
      case 0xf8:
        return r[F8]!;
      case 0xf9:
        return r[F9]!;
      case 0xfd:
      case 0xfe:
      case 0xff: {
        const b = T0 + 5 * (addr - 0xfd) + 4;
        const v = r[b]! & 15;
        r[b] = 0;
        return v;
      }
    }
    return 0;
  }

  private mmioWrite(addr: number, v: number): void {
    const r = this.r;
    switch (addr) {
      case 0xf1:
        r[IPL] = v & 0x80 ? 1 : 0;
        if (v & 0x20) {
          r[CPU_PORT + 3] = 0;
          r[CPU_PORT + 2] = 0;
        }
        if (v & 0x10) {
          r[CPU_PORT + 1] = 0;
          r[CPU_PORT] = 0;
        }
        for (let k = 2; k >= 0; k--) {
          const b = T0 + 5 * k;
          const on = (v >> k) & 1;
          if (!r[b] && on) {
            r[b + 3] = 0;
            r[b + 4] = 0;
          }
          r[b] = on;
        }
        break;
      case 0xf2:
        r[DSP_ADDR] = v;
        break;
      case 0xf3:
        if (!(r[DSP_ADDR]! & 0x80)) this.dsp.write(r[DSP_ADDR]!, v);
        break;
      case 0xf8:
        r[F8] = v;
        break;
      case 0xf9:
        r[F9] = v;
        break;
      case 0xfa:
      case 0xfb:
      case 0xfc:
        r[T0 + 5 * (addr - 0xfa) + 1] = v;
        break;
    }
  }

  private io(clocks = 1): void {
    this.tick(clocks);
  }

  private read(addr: number): number {
    addr &= 0xffff;
    this.tick(1);
    if ((addr & 0xfff0) === 0x00f0) return this.mmioRead(addr);
    if (addr >= 0xffc0 && this.r[IPL]) return IPL_ROM[addr & 0x3f]!;
    return this.ram[addr]!;
  }

  private write(addr: number, v: number): void {
    addr &= 0xffff;
    v &= 0xff;
    this.tick(1);
    if ((addr & 0xfff0) === 0x00f0) this.mmioWrite(addr, v);
    this.ram[addr] = v; // every write reaches RAM, MMIO too
  }

  private readpc(): number {
    const w = this.w;
    const v = this.read(w[PC]!);
    w[PC] = w[PC]! + 1;
    return v;
  }

  private readdp(addr: number): number {
    return this.read((this.r[FP]! << 8) + (addr & 0xff));
  }

  private writedp(addr: number, v: number): void {
    this.write((this.r[FP]! << 8) + (addr & 0xff), v);
  }

  private readstack(): number {
    this.tick(1);
    this.r[S] = this.r[S]! + 1;
    return this.ram[0x100 | this.r[S]!]!;
  }

  private writestack(v: number): void {
    this.tick(1);
    this.ram[0x100 | this.r[S]!] = v & 0xff;
    this.r[S] = this.r[S]! - 1;
  }

  // ---- ALU (apu/bapu/smp/algorithms.cpp) ---------------------------------------------------

  private adc(x: number, y: number): number {
    const r = this.r;
    x &= 0xff;
    y &= 0xff;
    const v = x + y + r[FC]!;
    r[FN] = (v >> 7) & 1;
    r[FV] = ~(x ^ y) & (x ^ v) & 0x80 ? 1 : 0;
    r[FH] = (x ^ y ^ v) & 0x10 ? 1 : 0;
    r[FZ] = (v & 0xff) === 0 ? 1 : 0;
    r[FC] = v > 0xff ? 1 : 0;
    return v & 0xff;
  }

  private addw(x: number, y: number): number {
    this.r[FC] = 0;
    let v = this.adc(x, y);
    v |= this.adc(x >> 8, y >> 8) << 8;
    this.r[FZ] = v === 0 ? 1 : 0;
    return v;
  }

  private and(x: number, y: number): number {
    return this.nz((x & y) & 0xff);
  }

  private cmp(x: number, y: number): number {
    const r = this.r;
    const v = (x & 0xff) - (y & 0xff);
    r[FN] = v & 0x80 ? 1 : 0;
    r[FZ] = (v & 0xff) === 0 ? 1 : 0;
    r[FC] = v >= 0 ? 1 : 0;
    return x;
  }

  private cmpw(x: number, y: number): number {
    const r = this.r;
    const v = x - y;
    r[FN] = v & 0x8000 ? 1 : 0;
    r[FZ] = (v & 0xffff) === 0 ? 1 : 0;
    r[FC] = v >= 0 ? 1 : 0;
    return x;
  }

  private eor(x: number, y: number): number {
    return this.nz((x ^ y) & 0xff);
  }

  private or(x: number, y: number): number {
    return this.nz((x | y) & 0xff);
  }

  private sbc(x: number, y: number): number {
    const r = this.r;
    x &= 0xff;
    y &= 0xff;
    const v = x - y - (r[FC]! ^ 1);
    r[FN] = v & 0x80 ? 1 : 0;
    r[FV] = (x ^ y) & (x ^ v) & 0x80 ? 1 : 0;
    r[FH] = (x ^ y ^ v) & 0x10 ? 0 : 1;
    r[FZ] = (v & 0xff) === 0 ? 1 : 0;
    r[FC] = v >= 0 ? 1 : 0;
    return v & 0xff;
  }

  private subw(x: number, y: number): number {
    this.r[FC] = 1;
    let v = this.sbc(x, y);
    v |= this.sbc(x >> 8, y >> 8) << 8;
    this.r[FZ] = v === 0 ? 1 : 0;
    return v;
  }

  private inc(x: number): number {
    return this.nz((x + 1) & 0xff);
  }

  private dec(x: number): number {
    return this.nz((x - 1) & 0xff);
  }

  private asl(x: number): number {
    this.r[FC] = (x >> 7) & 1;
    return this.nz((x << 1) & 0xff);
  }

  private lsr(x: number): number {
    this.r[FC] = x & 1;
    return this.nz((x & 0xff) >> 1);
  }

  private rol(x: number): number {
    const c = this.r[FC]!;
    this.r[FC] = (x >> 7) & 1;
    return this.nz(((x << 1) | c) & 0xff);
  }

  private ror(x: number): number {
    const c = this.r[FC]! << 7;
    this.r[FC] = x & 1;
    return this.nz(c | ((x & 0xff) >> 1));
  }

  private nz(v: number): number {
    this.r[FN] = (v >> 7) & 1;
    this.r[FZ] = v === 0 ? 1 : 0;
    return v;
  }

  // ---- instructions (apu/bapu/smp/core/oppseudo_*.cpp) -------------------------------------

  private step(): void {
    const r = this.r;
    const w = this.w;
    if (r[OC] === 0) r[ON] = this.readpc();
    switch (r[ON]!) {
      case 0x00: {
        this.io();
        break;
      }

      case 0xef: {
        this.io(2);
        w[PC]!--;
        break;
      }

      case 0xff: {
        this.io(2);
        w[PC]!--;
        break;
      }

      case 0x9f: {
        this.io(4);
        r[A]! = (r[A]! >> 4) | (r[A]! << 4);
        r[FN]! = !!(r[A]! & 0x80) ? 1 : 0;
        r[FZ]! = (r[A]! == 0) ? 1 : 0;
        break;
      }

      case 0xdf: {
        this.io(2);
        if(r[FC]! || (r[A]!) > 0x99) {
          r[A]! += 0x60;
          r[FC]! = 1;
        }
        if(r[FH]! || (r[A]! & 15) > 0x09) {
          r[A]! += 0x06;
        }
        r[FN]! = !!(r[A]! & 0x80) ? 1 : 0;
        r[FZ]! = (r[A]! == 0) ? 1 : 0;
        break;
      }

      case 0xbe: {
        this.io(2);
        if(!r[FC]! || (r[A]!) > 0x99) {
          r[A]! -= 0x60;
          r[FC]! = 0;
        }
        if(!r[FH]! || (r[A]! & 15) > 0x09) {
          r[A]! -= 0x06;
        }
        r[FN]! = !!(r[A]! & 0x80) ? 1 : 0;
        r[FZ]! = (r[A]! == 0) ? 1 : 0;
        break;
      }

      case 0x60: {
        this.io();
        r[FC]! = 0;
        break;
      }

      case 0x20: {
        this.io();
        r[FP]! = 0;
        break;
      }

      case 0x80: {
        this.io();
        r[FC]! = 1;
        break;
      }

      case 0x40: {
        this.io();
        r[FP]! = 1;
        break;
      }

      case 0xe0: {
        this.io();
        r[FV]! = 0;
        r[FH]! = 0;
        break;
      }

      case 0xed: {
        this.io(2);
        r[FC]! = !r[FC]! ? 1 : 0;
        break;
      }

      case 0xa0: {
        this.io(2);
        r[FI]! = 1;
        break;
      }

      case 0xc0: {
        this.io(2);
        r[FI]! = 0;
        break;
      }

      case 0x02: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        w[RD]! |=  0x01;
        this.writedp(w[DP]!, w[RD]!);
        break;
      }

      case 0x12: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        w[RD]! &= ~0x01;
        this.writedp(w[DP]!, w[RD]!);
        break;
      }

      case 0x22: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        w[RD]! |=  0x02;
        this.writedp(w[DP]!, w[RD]!);
        break;
      }

      case 0x32: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        w[RD]! &= ~0x02;
        this.writedp(w[DP]!, w[RD]!);
        break;
      }

      case 0x42: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        w[RD]! |=  0x04;
        this.writedp(w[DP]!, w[RD]!);
        break;
      }

      case 0x52: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        w[RD]! &= ~0x04;
        this.writedp(w[DP]!, w[RD]!);
        break;
      }

      case 0x62: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        w[RD]! |=  0x08;
        this.writedp(w[DP]!, w[RD]!);
        break;
      }

      case 0x72: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        w[RD]! &= ~0x08;
        this.writedp(w[DP]!, w[RD]!);
        break;
      }

      case 0x82: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        w[RD]! |=  0x10;
        this.writedp(w[DP]!, w[RD]!);
        break;
      }

      case 0x92: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        w[RD]! &= ~0x10;
        this.writedp(w[DP]!, w[RD]!);
        break;
      }

      case 0xa2: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        w[RD]! |=  0x20;
        this.writedp(w[DP]!, w[RD]!);
        break;
      }

      case 0xb2: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        w[RD]! &= ~0x20;
        this.writedp(w[DP]!, w[RD]!);
        break;
      }

      case 0xc2: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        w[RD]! |=  0x40;
        this.writedp(w[DP]!, w[RD]!);
        break;
      }

      case 0xd2: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        w[RD]! &= ~0x40;
        this.writedp(w[DP]!, w[RD]!);
        break;
      }

      case 0xe2: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        w[RD]! |=  0x80;
        this.writedp(w[DP]!, w[RD]!);
        break;
      }

      case 0xf2: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        w[RD]! &= ~0x80;
        this.writedp(w[DP]!, w[RD]!);
        break;
      }

      case 0x2d: {
        this.io(2);
        this.writestack(r[A]!);
        break;
      }

      case 0x4d: {
        this.io(2);
        this.writestack(r[X]!);
        break;
      }

      case 0x6d: {
        this.io(2);
        this.writestack(r[Y]!);
        break;
      }

      case 0x0d: {
        this.io(2);
        this.writestack(this.getP());
        break;
      }

      case 0xae: {
        this.io(2);
        r[A]! = this.readstack();
        break;
      }

      case 0xce: {
        this.io(2);
        r[X]! = this.readstack();
        break;
      }

      case 0xee: {
        this.io(2);
        r[Y]! = this.readstack();
        break;
      }

      case 0x8e: {
        this.io(2);
        this.setP(this.readstack());
        break;
      }

      case 0xcf: {
        this.io(8);
        w[YA]! = r[Y]! * r[A]!;
        r[A]! = w[YA]!;
        r[Y]! = w[YA]! >> 8;
        r[FN]! = !!(r[Y]! & 0x80) ? 1 : 0;
        r[FZ]! = (r[Y]! == 0) ? 1 : 0;
        break;
      }

      case 0x9e: {
        this.io(11);
        w[YA]! = this.ya();
        r[FV]! = !!(r[Y]! >= r[X]!) ? 1 : 0;
        r[FH]! = !!((r[Y]! & 15) >= (r[X]! & 15)) ? 1 : 0;
        if(r[Y]! < (r[X]! << 1)) {
          r[A]! = Math.trunc(w[YA]! / r[X]!);
          r[Y]! = w[YA]! % r[X]!;
        } else {
          r[A]! = 255 - Math.trunc((w[YA]! - (r[X]! << 9)) / (256 - r[X]!));
          r[Y]! = r[X]! + (w[YA]! - (r[X]! << 9)) % (256 - r[X]!);
        }
        r[FN]! = !!(r[A]! & 0x80) ? 1 : 0;
        r[FZ]! = (r[A]! == 0) ? 1 : 0;
        break;
      }

      case 0x7d: {
        this.io();
        r[A]! = r[X]!;
        r[FN]! = !!(r[A]! & 0x80) ? 1 : 0;
        r[FZ]! = (r[A]! == 0) ? 1 : 0;
        break;
      }

      case 0xdd: {
        this.io();
        r[A]! = r[Y]!;
        r[FN]! = !!(r[A]! & 0x80) ? 1 : 0;
        r[FZ]! = (r[A]! == 0) ? 1 : 0;
        break;
      }

      case 0x5d: {
        this.io();
        r[X]! = r[A]!;
        r[FN]! = !!(r[X]! & 0x80) ? 1 : 0;
        r[FZ]! = (r[X]! == 0) ? 1 : 0;
        break;
      }

      case 0xfd: {
        this.io();
        r[Y]! = r[A]!;
        r[FN]! = !!(r[Y]! & 0x80) ? 1 : 0;
        r[FZ]! = (r[Y]! == 0) ? 1 : 0;
        break;
      }

      case 0x9d: {
        this.io();
        r[X]! = r[S]!;
        r[FN]! = !!(r[X]! & 0x80) ? 1 : 0;
        r[FZ]! = (r[X]! == 0) ? 1 : 0;
        break;
      }

      case 0xbd: {
        this.io();
        r[S]! = r[X]!;
        break;
      }

      case 0xe8: {
        r[A]! = this.readpc();
        r[FN]! = !!(r[A]! & 0x80) ? 1 : 0;
        r[FZ]! = (r[A]! == 0) ? 1 : 0;
        break;
      }

      case 0xcd: {
        r[X]! = this.readpc();
        r[FN]! = !!(r[X]! & 0x80) ? 1 : 0;
        r[FZ]! = (r[X]! == 0) ? 1 : 0;
        break;
      }

      case 0x8d: {
        r[Y]! = this.readpc();
        r[FN]! = !!(r[Y]! & 0x80) ? 1 : 0;
        r[FZ]! = (r[Y]! == 0) ? 1 : 0;
        break;
      }

      case 0xe6: {
        switch(++r[OC]!) {
        case 1:
          this.io();
          break;
        case 2:
          r[A]! = this.readdp(r[X]!);
          r[FN]! = !!(r[A]! & 0x80) ? 1 : 0;
          r[FZ]! = (r[A]! == 0) ? 1 : 0;
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xbf: {
        switch(++r[OC]!) {
        case 1:
          this.io();
          break;
        case 2:
          r[A]! = this.readdp(r[X]!++);
          this.io();
          r[FN]! = !!(r[A]! & 0x80) ? 1 : 0;
          r[FZ]! = (r[A]! == 0) ? 1 : 0;
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xe4: {
        switch(++r[OC]!) {
        case 1:
          w[SP]! = this.readpc();
          break;
        case 2:
          r[A]! = this.readdp(w[SP]!);
          r[FN]! = !!(r[A]! & 0x80) ? 1 : 0;
          r[FZ]! = (r[A]! == 0) ? 1 : 0;
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xf8: {
        switch(++r[OC]!) {
        case 1:
          w[SP]! = this.readpc();
          break;
        case 2:
          r[X]! = this.readdp(w[SP]!);
          r[FN]! = !!(r[X]! & 0x80) ? 1 : 0;
          r[FZ]! = (r[X]! == 0) ? 1 : 0;
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xeb: {
        switch(++r[OC]!) {
        case 1:
          w[SP]! = this.readpc();
          break;
        case 2:
          r[Y]! = this.readdp(w[SP]!);
          r[FN]! = !!(r[Y]! & 0x80) ? 1 : 0;
          r[FZ]! = (r[Y]! == 0) ? 1 : 0;
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xf4: {
        switch(++r[OC]!) {
        case 1:
          w[SP]! = this.readpc();
          this.io();
          break;
        case 2:
          r[A]! = this.readdp(w[SP]! + r[X]!);
          r[FN]! = !!(r[A]! & 0x80) ? 1 : 0;
          r[FZ]! = (r[A]! == 0) ? 1 : 0;
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xf9: {
        switch(++r[OC]!) {
        case 1:
          w[SP]! = this.readpc();
          this.io();
          break;
        case 2:
          r[X]! = this.readdp(w[SP]! + r[Y]!);
          r[FN]! = !!(r[X]! & 0x80) ? 1 : 0;
          r[FZ]! = (r[X]! == 0) ? 1 : 0;
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xfb: {
        switch(++r[OC]!) {
        case 1:
          w[SP]! = this.readpc();
          this.io();
          break;
        case 2:
          r[Y]! = this.readdp(w[SP]! + r[X]!);
          r[FN]! = !!(r[Y]! & 0x80) ? 1 : 0;
          r[FZ]! = (r[Y]! == 0) ? 1 : 0;
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xe5: {
        switch(++r[OC]!) {
        case 1:
          w[SP]!  = this.readpc();
          break;
        case 2:
          w[SP]! |= this.readpc() << 8;
          break;
        case 3:
          r[A]! = this.read(w[SP]!);
          r[FN]! = !!(r[A]! & 0x80) ? 1 : 0;
          r[FZ]! = (r[A]! == 0) ? 1 : 0;
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xe9: {
        switch(++r[OC]!) {
        case 1:
          w[SP]!  = this.readpc();
          w[SP]! |= this.readpc() << 8;
          break;
        case 2:
          r[X]! = this.read(w[SP]!);
          r[FN]! = !!(r[X]! & 0x80) ? 1 : 0;
          r[FZ]! = (r[X]! == 0) ? 1 : 0;
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xec: {
        switch(++r[OC]!) {
        case 1:
          w[SP]!  = this.readpc();
          w[SP]! |= this.readpc() << 8;
          break;
        case 2:
          r[Y]! = this.read(w[SP]!);
          r[FN]! = !!(r[Y]! & 0x80) ? 1 : 0;
          r[FZ]! = (r[Y]! == 0) ? 1 : 0;
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xf5: {
        switch(++r[OC]!) {
        case 1:
          w[SP]!  = this.readpc();
          w[SP]! |= this.readpc() << 8;
          this.io();
          break;
        case 2:
          r[A]! = this.read(w[SP]! + r[X]!);
          r[FN]! = !!(r[A]! & 0x80) ? 1 : 0;
          r[FZ]! = (r[A]! == 0) ? 1 : 0;
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xf6: {
        switch(++r[OC]!) {
        case 1:
          w[SP]!  = this.readpc();
          w[SP]! |= this.readpc() << 8;
          this.io();
          break;
        case 2:
          r[A]! = this.read(w[SP]! + r[Y]!);
          r[FN]! = !!(r[A]! & 0x80) ? 1 : 0;
          r[FZ]! = (r[A]! == 0) ? 1 : 0;
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xe7: {
        switch(++r[OC]!) {
        case 1:
          w[DP]! = this.readpc() + r[X]!;
          this.io();
          break;
        case 2:
          w[SP]!  = this.readdp(w[DP]!);
          break;
        case 3:
          w[SP]! |= this.readdp(w[DP]! + 1) << 8;
          break;
        case 4:
          r[A]! = this.read(w[SP]!);
          r[FN]! = !!(r[A]! & 0x80) ? 1 : 0;
          r[FZ]! = (r[A]! == 0) ? 1 : 0;
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xf7: {
        switch(++r[OC]!) {
        case 1:
          w[DP]! = this.readpc();
          this.io();
          break;
        case 2:
          w[SP]!  = this.readdp(w[DP]!);
          break;
        case 3:
          w[SP]! |= this.readdp(w[DP]! + 1) << 8;
          break;
        case 4:
          r[A]! = this.read(w[SP]! + r[Y]!);
          r[FN]! = !!(r[A]! & 0x80) ? 1 : 0;
          r[FZ]! = (r[A]! == 0) ? 1 : 0;
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xfa: {
        switch(++r[OC]!) {
        case 1:
          w[SP]! = this.readpc();
          break;
        case 2:
          w[RD]! = this.readdp(w[SP]!);
          break;
        case 3:
          w[DP]! = this.readpc();
          break;
        case 4:
          this.writedp(w[DP]!, w[RD]!);
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0x8f: {
        switch(++r[OC]!) {
        case 1:
          w[RD]! = this.readpc();
          w[DP]! = this.readpc();
          break;
        case 2:
          this.readdp(w[DP]!);
          break;
        case 3:
          this.writedp(w[DP]!, w[RD]!);
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xc6: {
        switch(++r[OC]!) {
        case 1:
          this.io();
          break;
        case 2:
          this.readdp(r[X]!);
          break;
        case 3:
          this.writedp(r[X]!, r[A]!);
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xaf: {
        switch(++r[OC]!) {
        case 1:
          this.io(2);
          break;
        case 2:
          this.writedp(r[X]!++, r[A]!);
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xc4: {
        switch(++r[OC]!) {
        case 1:
          w[DP]! = this.readpc();
          break;
        case 2:
          this.readdp(w[DP]!);
          break;
        case 3:
          this.writedp(w[DP]!, r[A]!);
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xd8: {
        switch(++r[OC]!) {
        case 1:
          w[DP]! = this.readpc();
          break;
        case 2:
          this.readdp(w[DP]!);
          break;
        case 3:
          this.writedp(w[DP]!, r[X]!);
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xcb: {
        switch(++r[OC]!) {
        case 1:
          w[DP]! = this.readpc();
          break;
        case 2:
          this.readdp(w[DP]!);
          break;
        case 3:
          this.writedp(w[DP]!, r[Y]!);
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xd4: {
        switch(++r[OC]!) {
        case 1:
          w[DP]!  = this.readpc();
          this.io();
          w[DP]! += r[X]!;
          break;
        case 2:
          this.readdp(w[DP]!);
          break;
        case 3:
          this.writedp(w[DP]!, r[A]!);
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xd9: {
        switch(++r[OC]!) {
        case 1:
          w[DP]!  = this.readpc();
          this.io();
          w[DP]! += r[Y]!;
          break;
        case 2:
          this.readdp(w[DP]!);
          break;
        case 3:
          this.writedp(w[DP]!, r[X]!);
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xdb: {
        switch(++r[OC]!) {
        case 1:
          w[DP]!  = this.readpc();
          this.io();
          w[DP]! += r[X]!;
          break;
        case 2:
          this.readdp(w[DP]!);
          break;
        case 3:
          this.writedp(w[DP]!, r[Y]!);
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xc5: {
        switch(++r[OC]!) {
        case 1:
          w[DP]!  = this.readpc();
          break;
        case 2:
          w[DP]! |= this.readpc() << 8;
          break;
        case 3:
          this.read(w[DP]!);
          break;
        case 4:
          this.write(w[DP]!, r[A]!);
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xc9: {
        switch(++r[OC]!) {
        case 1:
          w[DP]!  = this.readpc();
          break;
        case 2:
          w[DP]! |= this.readpc() << 8;
          break;
        case 3:
          this.read(w[DP]!);
          break;
        case 4:
          this.write(w[DP]!, r[X]!);
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xcc: {
        switch(++r[OC]!) {
        case 1:
          w[DP]!  = this.readpc();
          break;
        case 2:
          w[DP]! |= this.readpc() << 8;
          break;
        case 3:
          this.read(w[DP]!);
          break;
        case 4:
          this.write(w[DP]!, r[Y]!);
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xd5: {
        switch(++r[OC]!) {
        case 1:
          w[DP]!  = this.readpc();
          w[DP]! |= this.readpc() << 8;
          this.io();
          w[DP]! += r[X]!;
          break;
        case 2:
          this.read(w[DP]!);
          break;
        case 3:
          this.write(w[DP]!, r[A]!);
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xd6: {
        switch(++r[OC]!) {
        case 1:
          w[DP]!  = this.readpc();
          w[DP]! |= this.readpc() << 8;
          this.io();
          w[DP]! += r[Y]!;
          break;
        case 2:
          this.read(w[DP]!);
          break;
        case 3:
          this.write(w[DP]!, r[A]!);
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xc7: {
        switch(++r[OC]!) {
        case 1:
          w[SP]!  = this.readpc();
          this.io();
          w[SP]! += r[X]!;
          break;
        case 2:
          w[DP]!  = this.readdp(w[SP]!);
          break;
        case 3:
          w[DP]! |= this.readdp(w[SP]! + 1) << 8;
          break;
        case 4:
          this.read(w[DP]!);
          break;
        case 5:
          this.write(w[DP]!, r[A]!);
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xd7: {
        switch(++r[OC]!) {
        case 1:
          w[SP]!  = this.readpc();
          break;
        case 2:
          w[DP]!  = this.readdp(w[SP]!);
          break;
        case 3:
          w[DP]! |= this.readdp(w[SP]! + 1) << 8;
          this.io();
          w[DP]! += r[Y]!;
          break;
        case 4:
          this.read(w[DP]!);
          break;
        case 5:
          this.write(w[DP]!, r[A]!);
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xba: {
        switch(++r[OC]!) {
        case 1:
          w[SP]! = this.readpc();
          break;
        case 2:
          r[A]! = this.readdp(w[SP]!);
          this.io();
          break;
        case 3:
          r[Y]! = this.readdp(w[SP]! + 1);
          r[FN]! = !!(this.ya() & 0x8000) ? 1 : 0;
          r[FZ]! = (this.ya() == 0) ? 1 : 0;
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xda: {
        switch(++r[OC]!) {
        case 1:
          w[DP]! = this.readpc();
          break;
        case 2:
          this.readdp(w[DP]!);
          break;
        case 3:
          this.writedp(w[DP]!,     r[A]!);
          break;
        case 4:
          this.writedp(w[DP]! + 1, r[Y]!);
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xaa: {
        switch(++r[OC]!) {
        case 1:
          w[SP]!  = this.readpc();
          w[SP]! |= this.readpc() << 8;
          break;
        case 2:
          w[BIT]! = w[SP]! >> 13;
          w[SP]! &= 0x1fff;
          w[RD]! = this.read(w[SP]!);
          r[FC]! = !!(w[RD]! & (1 << w[BIT]!)) ? 1 : 0;
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0xca: {
        switch(++r[OC]!) {
        case 1:
          w[DP]!  = this.readpc();
          w[DP]! |= this.readpc() << 8;
          break;
        case 2:
          w[BIT]! = w[DP]! >> 13;
          w[DP]! &= 0x1fff;
          w[RD]! = this.read(w[DP]!);
          if(r[FC]!)w[RD]! |=  (1 << w[BIT]!);
          else        w[RD]! &= ~(1 << w[BIT]!);
          this.io();
          break;
        case 3:
          this.write(w[DP]!, w[RD]!);
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0x2f: {
        w[RD]! = this.readpc();
        
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0xf0: {
        w[RD]! = this.readpc();
        if(!r[FZ]!){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0xd0: {
        w[RD]! = this.readpc();
        if(r[FZ]!){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0xb0: {
        w[RD]! = this.readpc();
        if(!r[FC]!){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0x90: {
        w[RD]! = this.readpc();
        if(r[FC]!){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0x70: {
        w[RD]! = this.readpc();
        if(!r[FV]!){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0x50: {
        w[RD]! = this.readpc();
        if(r[FV]!){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0x30: {
        w[RD]! = this.readpc();
        if(!r[FN]!){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0x10: {
        w[RD]! = this.readpc();
        if(r[FN]!){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0x03: {
        w[DP]! = this.readpc();
        w[SP]! = this.readdp(w[DP]!);
        w[RD]! = this.readpc();
        this.io();
        if((w[SP]! & 0x01) != 0x01){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0x13: {
        w[DP]! = this.readpc();
        w[SP]! = this.readdp(w[DP]!);
        w[RD]! = this.readpc();
        this.io();
        if((w[SP]! & 0x01) == 0x01){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0x23: {
        w[DP]! = this.readpc();
        w[SP]! = this.readdp(w[DP]!);
        w[RD]! = this.readpc();
        this.io();
        if((w[SP]! & 0x02) != 0x02){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0x33: {
        w[DP]! = this.readpc();
        w[SP]! = this.readdp(w[DP]!);
        w[RD]! = this.readpc();
        this.io();
        if((w[SP]! & 0x02) == 0x02){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0x43: {
        w[DP]! = this.readpc();
        w[SP]! = this.readdp(w[DP]!);
        w[RD]! = this.readpc();
        this.io();
        if((w[SP]! & 0x04) != 0x04){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0x53: {
        w[DP]! = this.readpc();
        w[SP]! = this.readdp(w[DP]!);
        w[RD]! = this.readpc();
        this.io();
        if((w[SP]! & 0x04) == 0x04){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0x63: {
        w[DP]! = this.readpc();
        w[SP]! = this.readdp(w[DP]!);
        w[RD]! = this.readpc();
        this.io();
        if((w[SP]! & 0x08) != 0x08){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0x73: {
        w[DP]! = this.readpc();
        w[SP]! = this.readdp(w[DP]!);
        w[RD]! = this.readpc();
        this.io();
        if((w[SP]! & 0x08) == 0x08){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0x83: {
        w[DP]! = this.readpc();
        w[SP]! = this.readdp(w[DP]!);
        w[RD]! = this.readpc();
        this.io();
        if((w[SP]! & 0x10) != 0x10){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0x93: {
        w[DP]! = this.readpc();
        w[SP]! = this.readdp(w[DP]!);
        w[RD]! = this.readpc();
        this.io();
        if((w[SP]! & 0x10) == 0x10){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0xa3: {
        w[DP]! = this.readpc();
        w[SP]! = this.readdp(w[DP]!);
        w[RD]! = this.readpc();
        this.io();
        if((w[SP]! & 0x20) != 0x20){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0xb3: {
        w[DP]! = this.readpc();
        w[SP]! = this.readdp(w[DP]!);
        w[RD]! = this.readpc();
        this.io();
        if((w[SP]! & 0x20) == 0x20){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0xc3: {
        w[DP]! = this.readpc();
        w[SP]! = this.readdp(w[DP]!);
        w[RD]! = this.readpc();
        this.io();
        if((w[SP]! & 0x40) != 0x40){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0xd3: {
        w[DP]! = this.readpc();
        w[SP]! = this.readdp(w[DP]!);
        w[RD]! = this.readpc();
        this.io();
        if((w[SP]! & 0x40) == 0x40){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0xe3: {
        w[DP]! = this.readpc();
        w[SP]! = this.readdp(w[DP]!);
        w[RD]! = this.readpc();
        this.io();
        if((w[SP]! & 0x80) != 0x80){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0xf3: {
        w[DP]! = this.readpc();
        w[SP]! = this.readdp(w[DP]!);
        w[RD]! = this.readpc();
        this.io();
        if((w[SP]! & 0x80) == 0x80){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0x2e: {
        w[DP]! = this.readpc();
        w[SP]! = this.readdp(w[DP]!);
        w[RD]! = this.readpc();
        this.io();
        if(r[A]! == w[SP]!){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0xde: {
        w[DP]! = this.readpc();
        this.io();
        w[SP]! = this.readdp(w[DP]! + r[X]!);
        w[RD]! = this.readpc();
        this.io();
        if(r[A]! == w[SP]!){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0x6e: {
        w[DP]! = this.readpc();
        w[WR]! = this.readdp(w[DP]!);
        this.writedp(w[DP]!, --w[WR]!);
        w[RD]! = this.readpc();
        if(w[WR]! == 0x00){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0xfe: {
        w[RD]! = this.readpc();
        this.io();
        r[Y]!--;
        this.io();
        if(r[Y]! == 0x00){ break; }
        this.io(2);
        w[PC]! += ((w[RD]! << 24) >> 24);
        break;
      }

      case 0x5f: {
        w[RD]!  = this.readpc();
        w[RD]! |= this.readpc() << 8;
        w[PC]! = w[RD]!;
        break;
      }

      case 0x1f: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        this.io();
        w[DP]! += r[X]!;
        w[RD]!  = this.read(w[DP]!);
        w[RD]! |= this.read(w[DP]! + 1) << 8;
        w[PC]! = w[RD]!;
        break;
      }

      case 0x3f: {
        w[RD]!  = this.readpc();
        w[RD]! |= this.readpc() << 8;
        this.io(3);
        this.writestack(w[PC]! >> 8);
        this.writestack(w[PC]!);
        w[PC]! = w[RD]!;
        break;
      }

      case 0x4f: {
        w[RD]! = this.readpc();
        this.io(2);
        this.writestack(w[PC]! >> 8);
        this.writestack(w[PC]!);
        w[PC]! = 0xff00 | w[RD]!;
        break;
      }

      case 0x01: {
        w[DP]! = 0xffde - (0 << 1);
        w[RD]!  = this.read(w[DP]!);
        w[RD]! |= this.read(w[DP]! + 1) << 8;
        this.io(3);
        this.writestack(w[PC]! >> 8);
        this.writestack(w[PC]!);
        w[PC]! = w[RD]!;
        break;
      }

      case 0x11: {
        w[DP]! = 0xffde - (1 << 1);
        w[RD]!  = this.read(w[DP]!);
        w[RD]! |= this.read(w[DP]! + 1) << 8;
        this.io(3);
        this.writestack(w[PC]! >> 8);
        this.writestack(w[PC]!);
        w[PC]! = w[RD]!;
        break;
      }

      case 0x21: {
        w[DP]! = 0xffde - (2 << 1);
        w[RD]!  = this.read(w[DP]!);
        w[RD]! |= this.read(w[DP]! + 1) << 8;
        this.io(3);
        this.writestack(w[PC]! >> 8);
        this.writestack(w[PC]!);
        w[PC]! = w[RD]!;
        break;
      }

      case 0x31: {
        w[DP]! = 0xffde - (3 << 1);
        w[RD]!  = this.read(w[DP]!);
        w[RD]! |= this.read(w[DP]! + 1) << 8;
        this.io(3);
        this.writestack(w[PC]! >> 8);
        this.writestack(w[PC]!);
        w[PC]! = w[RD]!;
        break;
      }

      case 0x41: {
        w[DP]! = 0xffde - (4 << 1);
        w[RD]!  = this.read(w[DP]!);
        w[RD]! |= this.read(w[DP]! + 1) << 8;
        this.io(3);
        this.writestack(w[PC]! >> 8);
        this.writestack(w[PC]!);
        w[PC]! = w[RD]!;
        break;
      }

      case 0x51: {
        w[DP]! = 0xffde - (5 << 1);
        w[RD]!  = this.read(w[DP]!);
        w[RD]! |= this.read(w[DP]! + 1) << 8;
        this.io(3);
        this.writestack(w[PC]! >> 8);
        this.writestack(w[PC]!);
        w[PC]! = w[RD]!;
        break;
      }

      case 0x61: {
        w[DP]! = 0xffde - (6 << 1);
        w[RD]!  = this.read(w[DP]!);
        w[RD]! |= this.read(w[DP]! + 1) << 8;
        this.io(3);
        this.writestack(w[PC]! >> 8);
        this.writestack(w[PC]!);
        w[PC]! = w[RD]!;
        break;
      }

      case 0x71: {
        w[DP]! = 0xffde - (7 << 1);
        w[RD]!  = this.read(w[DP]!);
        w[RD]! |= this.read(w[DP]! + 1) << 8;
        this.io(3);
        this.writestack(w[PC]! >> 8);
        this.writestack(w[PC]!);
        w[PC]! = w[RD]!;
        break;
      }

      case 0x81: {
        w[DP]! = 0xffde - (8 << 1);
        w[RD]!  = this.read(w[DP]!);
        w[RD]! |= this.read(w[DP]! + 1) << 8;
        this.io(3);
        this.writestack(w[PC]! >> 8);
        this.writestack(w[PC]!);
        w[PC]! = w[RD]!;
        break;
      }

      case 0x91: {
        w[DP]! = 0xffde - (9 << 1);
        w[RD]!  = this.read(w[DP]!);
        w[RD]! |= this.read(w[DP]! + 1) << 8;
        this.io(3);
        this.writestack(w[PC]! >> 8);
        this.writestack(w[PC]!);
        w[PC]! = w[RD]!;
        break;
      }

      case 0xa1: {
        w[DP]! = 0xffde - (10 << 1);
        w[RD]!  = this.read(w[DP]!);
        w[RD]! |= this.read(w[DP]! + 1) << 8;
        this.io(3);
        this.writestack(w[PC]! >> 8);
        this.writestack(w[PC]!);
        w[PC]! = w[RD]!;
        break;
      }

      case 0xb1: {
        w[DP]! = 0xffde - (11 << 1);
        w[RD]!  = this.read(w[DP]!);
        w[RD]! |= this.read(w[DP]! + 1) << 8;
        this.io(3);
        this.writestack(w[PC]! >> 8);
        this.writestack(w[PC]!);
        w[PC]! = w[RD]!;
        break;
      }

      case 0xc1: {
        w[DP]! = 0xffde - (12 << 1);
        w[RD]!  = this.read(w[DP]!);
        w[RD]! |= this.read(w[DP]! + 1) << 8;
        this.io(3);
        this.writestack(w[PC]! >> 8);
        this.writestack(w[PC]!);
        w[PC]! = w[RD]!;
        break;
      }

      case 0xd1: {
        w[DP]! = 0xffde - (13 << 1);
        w[RD]!  = this.read(w[DP]!);
        w[RD]! |= this.read(w[DP]! + 1) << 8;
        this.io(3);
        this.writestack(w[PC]! >> 8);
        this.writestack(w[PC]!);
        w[PC]! = w[RD]!;
        break;
      }

      case 0xe1: {
        w[DP]! = 0xffde - (14 << 1);
        w[RD]!  = this.read(w[DP]!);
        w[RD]! |= this.read(w[DP]! + 1) << 8;
        this.io(3);
        this.writestack(w[PC]! >> 8);
        this.writestack(w[PC]!);
        w[PC]! = w[RD]!;
        break;
      }

      case 0xf1: {
        w[DP]! = 0xffde - (15 << 1);
        w[RD]!  = this.read(w[DP]!);
        w[RD]! |= this.read(w[DP]! + 1) << 8;
        this.io(3);
        this.writestack(w[PC]! >> 8);
        this.writestack(w[PC]!);
        w[PC]! = w[RD]!;
        break;
      }

      case 0x0f: {
        w[RD]!  = this.read(0xffde);
        w[RD]! |= this.read(0xffdf) << 8;
        this.io(2);
        this.writestack(w[PC]! >> 8);
        this.writestack(w[PC]!);
        this.writestack(this.getP());
        w[PC]! = w[RD]!;
        r[FB]! = 1;
        r[FI]! = 0;
        break;
      }

      case 0x6f: {
        w[RD]!  = this.readstack();
        w[RD]! |= this.readstack() << 8;
        this.io(2);
        w[PC]! = w[RD]!;
        break;
      }

      case 0x7f: {
        this.setP(this.readstack());
        w[RD]!  = this.readstack();
        w[RD]! |= this.readstack() << 8;
        this.io(2);
        w[PC]! = w[RD]!;
        break;
      }

      case 0x88: {
        w[RD]! = this.readpc();
        r[A]! = this.adc(r[A]!, w[RD]!);
        break;
      }

      case 0x28: {
        w[RD]! = this.readpc();
        r[A]! = this.and(r[A]!, w[RD]!);
        break;
      }

      case 0x68: {
        w[RD]! = this.readpc();
        r[A]! = this.cmp(r[A]!, w[RD]!);
        break;
      }

      case 0xc8: {
        w[RD]! = this.readpc();
        r[X]! = this.cmp(r[X]!, w[RD]!);
        break;
      }

      case 0xad: {
        w[RD]! = this.readpc();
        r[Y]! = this.cmp(r[Y]!, w[RD]!);
        break;
      }

      case 0x48: {
        w[RD]! = this.readpc();
        r[A]! = this.eor(r[A]!, w[RD]!);
        break;
      }

      case 0x08: {
        w[RD]! = this.readpc();
        r[A]! = this.or(r[A]!, w[RD]!);
        break;
      }

      case 0xa8: {
        w[RD]! = this.readpc();
        r[A]! = this.sbc(r[A]!, w[RD]!);
        break;
      }

      case 0x86: {
        this.io();
        w[RD]! = this.readdp(r[X]!);
        r[A]! = this.adc(r[A]!, w[RD]!);
        break;
      }

      case 0x26: {
        this.io();
        w[RD]! = this.readdp(r[X]!);
        r[A]! = this.and(r[A]!, w[RD]!);
        break;
      }

      case 0x66: {
        this.io();
        w[RD]! = this.readdp(r[X]!);
        r[A]! = this.cmp(r[A]!, w[RD]!);
        break;
      }

      case 0x46: {
        this.io();
        w[RD]! = this.readdp(r[X]!);
        r[A]! = this.eor(r[A]!, w[RD]!);
        break;
      }

      case 0x06: {
        this.io();
        w[RD]! = this.readdp(r[X]!);
        r[A]! = this.or(r[A]!, w[RD]!);
        break;
      }

      case 0xa6: {
        this.io();
        w[RD]! = this.readdp(r[X]!);
        r[A]! = this.sbc(r[A]!, w[RD]!);
        break;
      }

      case 0x84: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        r[A]! = this.adc(r[A]!, w[RD]!);
        break;
      }

      case 0x24: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        r[A]! = this.and(r[A]!, w[RD]!);
        break;
      }

      case 0x64: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        r[A]! = this.cmp(r[A]!, w[RD]!);
        break;
      }

      case 0x3e: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        r[X]! = this.cmp(r[X]!, w[RD]!);
        break;
      }

      case 0x7e: {
        switch(++r[OC]!) {
        case 1:
          w[DP]! = this.readpc();
          break;
        case 2:
          w[RD]! = this.readdp(w[DP]!);
          r[Y]! = this.cmp(r[Y]!, w[RD]!);
          r[OC]! = 0;
          break;
        }
        break;
      }

      case 0x44: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        r[A]! = this.eor(r[A]!, w[RD]!);
        break;
      }

      case 0x04: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        r[A]! = this.or(r[A]!, w[RD]!);
        break;
      }

      case 0xa4: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        r[A]! = this.sbc(r[A]!, w[RD]!);
        break;
      }

      case 0x94: {
        w[DP]! = this.readpc();
        this.io();
        w[RD]! = this.readdp(w[DP]! + r[X]!);
        r[A]! = this.adc(r[A]!, w[RD]!);
        break;
      }

      case 0x34: {
        w[DP]! = this.readpc();
        this.io();
        w[RD]! = this.readdp(w[DP]! + r[X]!);
        r[A]! = this.and(r[A]!, w[RD]!);
        break;
      }

      case 0x74: {
        w[DP]! = this.readpc();
        this.io();
        w[RD]! = this.readdp(w[DP]! + r[X]!);
        r[A]! = this.cmp(r[A]!, w[RD]!);
        break;
      }

      case 0x54: {
        w[DP]! = this.readpc();
        this.io();
        w[RD]! = this.readdp(w[DP]! + r[X]!);
        r[A]! = this.eor(r[A]!, w[RD]!);
        break;
      }

      case 0x14: {
        w[DP]! = this.readpc();
        this.io();
        w[RD]! = this.readdp(w[DP]! + r[X]!);
        r[A]! = this.or(r[A]!, w[RD]!);
        break;
      }

      case 0xb4: {
        w[DP]! = this.readpc();
        this.io();
        w[RD]! = this.readdp(w[DP]! + r[X]!);
        r[A]! = this.sbc(r[A]!, w[RD]!);
        break;
      }

      case 0x85: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        w[RD]! = this.read(w[DP]!);
        r[A]! = this.adc(r[A]!, w[RD]!);
        break;
      }

      case 0x25: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        w[RD]! = this.read(w[DP]!);
        r[A]! = this.and(r[A]!, w[RD]!);
        break;
      }

      case 0x65: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        w[RD]! = this.read(w[DP]!);
        r[A]! = this.cmp(r[A]!, w[RD]!);
        break;
      }

      case 0x1e: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        w[RD]! = this.read(w[DP]!);
        r[X]! = this.cmp(r[X]!, w[RD]!);
        break;
      }

      case 0x5e: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        w[RD]! = this.read(w[DP]!);
        r[Y]! = this.cmp(r[Y]!, w[RD]!);
        break;
      }

      case 0x45: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        w[RD]! = this.read(w[DP]!);
        r[A]! = this.eor(r[A]!, w[RD]!);
        break;
      }

      case 0x05: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        w[RD]! = this.read(w[DP]!);
        r[A]! = this.or(r[A]!, w[RD]!);
        break;
      }

      case 0xa5: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        w[RD]! = this.read(w[DP]!);
        r[A]! = this.sbc(r[A]!, w[RD]!);
        break;
      }

      case 0x95: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        this.io();
        w[RD]! = this.read(w[DP]! + r[X]!);
        r[A]! = this.adc(r[A]!, w[RD]!);
        break;
      }

      case 0x96: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        this.io();
        w[RD]! = this.read(w[DP]! + r[Y]!);
        r[A]! = this.adc(r[A]!, w[RD]!);
        break;
      }

      case 0x35: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        this.io();
        w[RD]! = this.read(w[DP]! + r[X]!);
        r[A]! = this.and(r[A]!, w[RD]!);
        break;
      }

      case 0x36: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        this.io();
        w[RD]! = this.read(w[DP]! + r[Y]!);
        r[A]! = this.and(r[A]!, w[RD]!);
        break;
      }

      case 0x75: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        this.io();
        w[RD]! = this.read(w[DP]! + r[X]!);
        r[A]! = this.cmp(r[A]!, w[RD]!);
        break;
      }

      case 0x76: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        this.io();
        w[RD]! = this.read(w[DP]! + r[Y]!);
        r[A]! = this.cmp(r[A]!, w[RD]!);
        break;
      }

      case 0x55: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        this.io();
        w[RD]! = this.read(w[DP]! + r[X]!);
        r[A]! = this.eor(r[A]!, w[RD]!);
        break;
      }

      case 0x56: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        this.io();
        w[RD]! = this.read(w[DP]! + r[Y]!);
        r[A]! = this.eor(r[A]!, w[RD]!);
        break;
      }

      case 0x15: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        this.io();
        w[RD]! = this.read(w[DP]! + r[X]!);
        r[A]! = this.or(r[A]!, w[RD]!);
        break;
      }

      case 0x16: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        this.io();
        w[RD]! = this.read(w[DP]! + r[Y]!);
        r[A]! = this.or(r[A]!, w[RD]!);
        break;
      }

      case 0xb5: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        this.io();
        w[RD]! = this.read(w[DP]! + r[X]!);
        r[A]! = this.sbc(r[A]!, w[RD]!);
        break;
      }

      case 0xb6: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        this.io();
        w[RD]! = this.read(w[DP]! + r[Y]!);
        r[A]! = this.sbc(r[A]!, w[RD]!);
        break;
      }

      case 0x87: {
        w[DP]! = this.readpc() + r[X]!;
        this.io();
        w[SP]!  = this.readdp(w[DP]!);
        w[SP]! |= this.readdp(w[DP]! + 1) << 8;
        w[RD]! = this.read(w[SP]!);
        r[A]! = this.adc(r[A]!, w[RD]!);
        break;
      }

      case 0x27: {
        w[DP]! = this.readpc() + r[X]!;
        this.io();
        w[SP]!  = this.readdp(w[DP]!);
        w[SP]! |= this.readdp(w[DP]! + 1) << 8;
        w[RD]! = this.read(w[SP]!);
        r[A]! = this.and(r[A]!, w[RD]!);
        break;
      }

      case 0x67: {
        w[DP]! = this.readpc() + r[X]!;
        this.io();
        w[SP]!  = this.readdp(w[DP]!);
        w[SP]! |= this.readdp(w[DP]! + 1) << 8;
        w[RD]! = this.read(w[SP]!);
        r[A]! = this.cmp(r[A]!, w[RD]!);
        break;
      }

      case 0x47: {
        w[DP]! = this.readpc() + r[X]!;
        this.io();
        w[SP]!  = this.readdp(w[DP]!);
        w[SP]! |= this.readdp(w[DP]! + 1) << 8;
        w[RD]! = this.read(w[SP]!);
        r[A]! = this.eor(r[A]!, w[RD]!);
        break;
      }

      case 0x07: {
        w[DP]! = this.readpc() + r[X]!;
        this.io();
        w[SP]!  = this.readdp(w[DP]!);
        w[SP]! |= this.readdp(w[DP]! + 1) << 8;
        w[RD]! = this.read(w[SP]!);
        r[A]! = this.or(r[A]!, w[RD]!);
        break;
      }

      case 0xa7: {
        w[DP]! = this.readpc() + r[X]!;
        this.io();
        w[SP]!  = this.readdp(w[DP]!);
        w[SP]! |= this.readdp(w[DP]! + 1) << 8;
        w[RD]! = this.read(w[SP]!);
        r[A]! = this.sbc(r[A]!, w[RD]!);
        break;
      }

      case 0x97: {
        w[DP]!  = this.readpc();
        this.io();
        w[SP]!  = this.readdp(w[DP]!);
        w[SP]! |= this.readdp(w[DP]! + 1) << 8;
        w[RD]! = this.read(w[SP]! + r[Y]!);
        r[A]! = this.adc(r[A]!, w[RD]!);
        break;
      }

      case 0x37: {
        w[DP]!  = this.readpc();
        this.io();
        w[SP]!  = this.readdp(w[DP]!);
        w[SP]! |= this.readdp(w[DP]! + 1) << 8;
        w[RD]! = this.read(w[SP]! + r[Y]!);
        r[A]! = this.and(r[A]!, w[RD]!);
        break;
      }

      case 0x77: {
        w[DP]!  = this.readpc();
        this.io();
        w[SP]!  = this.readdp(w[DP]!);
        w[SP]! |= this.readdp(w[DP]! + 1) << 8;
        w[RD]! = this.read(w[SP]! + r[Y]!);
        r[A]! = this.cmp(r[A]!, w[RD]!);
        break;
      }

      case 0x57: {
        w[DP]!  = this.readpc();
        this.io();
        w[SP]!  = this.readdp(w[DP]!);
        w[SP]! |= this.readdp(w[DP]! + 1) << 8;
        w[RD]! = this.read(w[SP]! + r[Y]!);
        r[A]! = this.eor(r[A]!, w[RD]!);
        break;
      }

      case 0x17: {
        w[DP]!  = this.readpc();
        this.io();
        w[SP]!  = this.readdp(w[DP]!);
        w[SP]! |= this.readdp(w[DP]! + 1) << 8;
        w[RD]! = this.read(w[SP]! + r[Y]!);
        r[A]! = this.or(r[A]!, w[RD]!);
        break;
      }

      case 0xb7: {
        w[DP]!  = this.readpc();
        this.io();
        w[SP]!  = this.readdp(w[DP]!);
        w[SP]! |= this.readdp(w[DP]! + 1) << 8;
        w[RD]! = this.read(w[SP]! + r[Y]!);
        r[A]! = this.sbc(r[A]!, w[RD]!);
        break;
      }

      case 0x99: {
        this.io();
        w[RD]! = this.readdp(r[Y]!);
        w[WR]! = this.readdp(r[X]!);
        w[WR]! = this.adc(w[WR]!, w[RD]!);
        this.writedp(r[X]!, w[WR]!);
        break;
      }

      case 0x39: {
        this.io();
        w[RD]! = this.readdp(r[Y]!);
        w[WR]! = this.readdp(r[X]!);
        w[WR]! = this.and(w[WR]!, w[RD]!);
        this.writedp(r[X]!, w[WR]!);
        break;
      }

      case 0x79: {
        this.io();
        w[RD]! = this.readdp(r[Y]!);
        w[WR]! = this.readdp(r[X]!);
        w[WR]! = this.cmp(w[WR]!, w[RD]!);
        this.io();
        break;
      }

      case 0x59: {
        this.io();
        w[RD]! = this.readdp(r[Y]!);
        w[WR]! = this.readdp(r[X]!);
        w[WR]! = this.eor(w[WR]!, w[RD]!);
        this.writedp(r[X]!, w[WR]!);
        break;
      }

      case 0x19: {
        this.io();
        w[RD]! = this.readdp(r[Y]!);
        w[WR]! = this.readdp(r[X]!);
        w[WR]! = this.or(w[WR]!, w[RD]!);
        this.writedp(r[X]!, w[WR]!);
        break;
      }

      case 0xb9: {
        this.io();
        w[RD]! = this.readdp(r[Y]!);
        w[WR]! = this.readdp(r[X]!);
        w[WR]! = this.sbc(w[WR]!, w[RD]!);
        this.writedp(r[X]!, w[WR]!);
        break;
      }

      case 0x89: {
        w[SP]! = this.readpc();
        w[RD]! = this.readdp(w[SP]!);
        w[DP]! = this.readpc();
        w[WR]! = this.readdp(w[DP]!);
        w[WR]! = this.adc(w[WR]!, w[RD]!);
        this.writedp(w[DP]!, w[WR]!);
        break;
      }

      case 0x29: {
        w[SP]! = this.readpc();
        w[RD]! = this.readdp(w[SP]!);
        w[DP]! = this.readpc();
        w[WR]! = this.readdp(w[DP]!);
        w[WR]! = this.and(w[WR]!, w[RD]!);
        this.writedp(w[DP]!, w[WR]!);
        break;
      }

      case 0x69: {
        w[SP]! = this.readpc();
        w[RD]! = this.readdp(w[SP]!);
        w[DP]! = this.readpc();
        w[WR]! = this.readdp(w[DP]!);
        w[WR]! = this.cmp(w[WR]!, w[RD]!);
        this.io();
        break;
      }

      case 0x49: {
        w[SP]! = this.readpc();
        w[RD]! = this.readdp(w[SP]!);
        w[DP]! = this.readpc();
        w[WR]! = this.readdp(w[DP]!);
        w[WR]! = this.eor(w[WR]!, w[RD]!);
        this.writedp(w[DP]!, w[WR]!);
        break;
      }

      case 0x09: {
        w[SP]! = this.readpc();
        w[RD]! = this.readdp(w[SP]!);
        w[DP]! = this.readpc();
        w[WR]! = this.readdp(w[DP]!);
        w[WR]! = this.or(w[WR]!, w[RD]!);
        this.writedp(w[DP]!, w[WR]!);
        break;
      }

      case 0xa9: {
        w[SP]! = this.readpc();
        w[RD]! = this.readdp(w[SP]!);
        w[DP]! = this.readpc();
        w[WR]! = this.readdp(w[DP]!);
        w[WR]! = this.sbc(w[WR]!, w[RD]!);
        this.writedp(w[DP]!, w[WR]!);
        break;
      }

      case 0x98: {
        w[RD]! = this.readpc();
        w[DP]! = this.readpc();
        w[WR]! = this.readdp(w[DP]!);
        w[WR]! = this.adc(w[WR]!, w[RD]!);
        this.writedp(w[DP]!, w[WR]!);
        break;
      }

      case 0x38: {
        w[RD]! = this.readpc();
        w[DP]! = this.readpc();
        w[WR]! = this.readdp(w[DP]!);
        w[WR]! = this.and(w[WR]!, w[RD]!);
        this.writedp(w[DP]!, w[WR]!);
        break;
      }

      case 0x78: {
        w[RD]! = this.readpc();
        w[DP]! = this.readpc();
        w[WR]! = this.readdp(w[DP]!);
        w[WR]! = this.cmp(w[WR]!, w[RD]!);
        this.io();
        break;
      }

      case 0x58: {
        w[RD]! = this.readpc();
        w[DP]! = this.readpc();
        w[WR]! = this.readdp(w[DP]!);
        w[WR]! = this.eor(w[WR]!, w[RD]!);
        this.writedp(w[DP]!, w[WR]!);
        break;
      }

      case 0x18: {
        w[RD]! = this.readpc();
        w[DP]! = this.readpc();
        w[WR]! = this.readdp(w[DP]!);
        w[WR]! = this.or(w[WR]!, w[RD]!);
        this.writedp(w[DP]!, w[WR]!);
        break;
      }

      case 0xb8: {
        w[RD]! = this.readpc();
        w[DP]! = this.readpc();
        w[WR]! = this.readdp(w[DP]!);
        w[WR]! = this.sbc(w[WR]!, w[RD]!);
        this.writedp(w[DP]!, w[WR]!);
        break;
      }

      case 0x7a: {
        w[DP]!  = this.readpc();
        w[RD]!  = this.readdp(w[DP]!);
        this.io();
        w[RD]! |= this.readdp(w[DP]! + 1) << 8;
        this.setYA(this.addw(this.ya(), w[RD]!));
        break;
      }

      case 0x9a: {
        w[DP]!  = this.readpc();
        w[RD]!  = this.readdp(w[DP]!);
        this.io();
        w[RD]! |= this.readdp(w[DP]! + 1) << 8;
        this.setYA(this.subw(this.ya(), w[RD]!));
        break;
      }

      case 0x5a: {
        w[DP]!  = this.readpc();
        w[RD]!  = this.readdp(w[DP]!);
        w[RD]! |= this.readdp(w[DP]! + 1) << 8;
        this.cmpw(this.ya(), w[RD]!);
        break;
      }

      case 0x4a: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        w[BIT]! = w[DP]! >> 13;
        w[DP]! &= 0x1fff;
        w[RD]! = this.read(w[DP]!);
        r[FC]! = r[FC]! & +!!(w[RD]! & (1 << w[BIT]!));
        break;
      }

      case 0x6a: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        w[BIT]! = w[DP]! >> 13;
        w[DP]! &= 0x1fff;
        w[RD]! = this.read(w[DP]!);
        r[FC]! = r[FC]! & +!(w[RD]! & (1 << w[BIT]!));
        break;
      }

      case 0x8a: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        w[BIT]! = w[DP]! >> 13;
        w[DP]! &= 0x1fff;
        w[RD]! = this.read(w[DP]!);
        this.io();
        r[FC]! = r[FC]! ^ +!!(w[RD]! & (1 << w[BIT]!));
        break;
      }

      case 0xea: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        w[BIT]! = w[DP]! >> 13;
        w[DP]! &= 0x1fff;
        w[RD]! = this.read(w[DP]!);
        w[RD]! ^= (1 << w[BIT]!);
        this.write(w[DP]!, w[RD]!);
        break;
      }

      case 0x0a: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        w[BIT]! = w[DP]! >> 13;
        w[DP]! &= 0x1fff;
        w[RD]! = this.read(w[DP]!);
        this.io();
        r[FC]! = r[FC]! | +!!(w[RD]! & (1 << w[BIT]!));
        break;
      }

      case 0x2a: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        w[BIT]! = w[DP]! >> 13;
        w[DP]! &= 0x1fff;
        w[RD]! = this.read(w[DP]!);
        this.io();
        r[FC]! = r[FC]! | +!(w[RD]! & (1 << w[BIT]!));
        break;
      }

      case 0xbc: {
        this.io();
        r[A]! = this.inc(r[A]!);
        break;
      }

      case 0x3d: {
        this.io();
        r[X]! = this.inc(r[X]!);
        break;
      }

      case 0xfc: {
        this.io();
        r[Y]! = this.inc(r[Y]!);
        break;
      }

      case 0x9c: {
        this.io();
        r[A]! = this.dec(r[A]!);
        break;
      }

      case 0x1d: {
        this.io();
        r[X]! = this.dec(r[X]!);
        break;
      }

      case 0xdc: {
        this.io();
        r[Y]! = this.dec(r[Y]!);
        break;
      }

      case 0x1c: {
        this.io();
        r[A]! = this.asl(r[A]!);
        break;
      }

      case 0x5c: {
        this.io();
        r[A]! = this.lsr(r[A]!);
        break;
      }

      case 0x3c: {
        this.io();
        r[A]! = this.rol(r[A]!);
        break;
      }

      case 0x7c: {
        this.io();
        r[A]! = this.ror(r[A]!);
          break;
      }

      case 0xab: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        w[RD]! = this.inc(w[RD]!);
        this.writedp(w[DP]!, w[RD]!);
        break;
      }

      case 0x8b: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        w[RD]! = this.dec(w[RD]!);
        this.writedp(w[DP]!, w[RD]!);
        break;
      }

      case 0x0b: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        w[RD]! = this.asl(w[RD]!);
        this.writedp(w[DP]!, w[RD]!);
        break;
      }

      case 0x4b: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        w[RD]! = this.lsr(w[RD]!);
        this.writedp(w[DP]!, w[RD]!);
        break;
      }

      case 0x2b: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        w[RD]! = this.rol(w[RD]!);
        this.writedp(w[DP]!, w[RD]!);
        break;
      }

      case 0x6b: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        w[RD]! = this.ror(w[RD]!);
        this.writedp(w[DP]!, w[RD]!);
        break;
      }

      case 0xbb: {
        w[DP]! = this.readpc();
        this.io();
        w[RD]! = this.readdp(w[DP]! + r[X]!);
        w[RD]! = this.inc(w[RD]!);
        this.writedp(w[DP]! + r[X]!, w[RD]!);
        break;
      }

      case 0x9b: {
        w[DP]! = this.readpc();
        this.io();
        w[RD]! = this.readdp(w[DP]! + r[X]!);
        w[RD]! = this.dec(w[RD]!);
        this.writedp(w[DP]! + r[X]!, w[RD]!);
        break;
      }

      case 0x1b: {
        w[DP]! = this.readpc();
        this.io();
        w[RD]! = this.readdp(w[DP]! + r[X]!);
        w[RD]! = this.asl(w[RD]!);
        this.writedp(w[DP]! + r[X]!, w[RD]!);
        break;
      }

      case 0x5b: {
        w[DP]! = this.readpc();
        this.io();
        w[RD]! = this.readdp(w[DP]! + r[X]!);
        w[RD]! = this.lsr(w[RD]!);
        this.writedp(w[DP]! + r[X]!, w[RD]!);
        break;
      }

      case 0x3b: {
        w[DP]! = this.readpc();
        this.io();
        w[RD]! = this.readdp(w[DP]! + r[X]!);
        w[RD]! = this.rol(w[RD]!);
        this.writedp(w[DP]! + r[X]!, w[RD]!);
        break;
      }

      case 0x7b: {
        w[DP]! = this.readpc();
        this.io();
        w[RD]! = this.readdp(w[DP]! + r[X]!);
        w[RD]! = this.ror(w[RD]!);
        this.writedp(w[DP]! + r[X]!, w[RD]!);
        break;
      }

      case 0xac: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        w[RD]! = this.read(w[DP]!);
        w[RD]! = this.inc(w[RD]!);
        this.write(w[DP]!, w[RD]!);
        break;
      }

      case 0x8c: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        w[RD]! = this.read(w[DP]!);
        w[RD]! = this.dec(w[RD]!);
        this.write(w[DP]!, w[RD]!);
        break;
      }

      case 0x0c: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        w[RD]! = this.read(w[DP]!);
        w[RD]! = this.asl(w[RD]!);
        this.write(w[DP]!, w[RD]!);
        break;
      }

      case 0x4c: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        w[RD]! = this.read(w[DP]!);
        w[RD]! = this.lsr(w[RD]!);
        this.write(w[DP]!, w[RD]!);
        break;
      }

      case 0x2c: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        w[RD]! = this.read(w[DP]!);
        w[RD]! = this.rol(w[RD]!);
        this.write(w[DP]!, w[RD]!);
        break;
      }

      case 0x6c: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        w[RD]! = this.read(w[DP]!);
        w[RD]! = this.ror(w[RD]!);
        this.write(w[DP]!, w[RD]!);
        break;
      }

      case 0x0e: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        w[RD]! = this.read(w[DP]!);
        r[FN]! = !!((r[A]! - w[RD]!) & 0x80) ? 1 : 0;
        r[FZ]! = ((r[A]! - w[RD]!) == 0) ? 1 : 0;
        this.read(w[DP]!);
        this.write(w[DP]!, w[RD]! | r[A]!);
        break;
      }

      case 0x4e: {
        w[DP]!  = this.readpc();
        w[DP]! |= this.readpc() << 8;
        w[RD]! = this.read(w[DP]!);
        r[FN]! = !!((r[A]! - w[RD]!) & 0x80) ? 1 : 0;
        r[FZ]! = ((r[A]! - w[RD]!) == 0) ? 1 : 0;
        this.read(w[DP]!);
        this.write(w[DP]!, w[RD]! &~ r[A]!);
        break;
      }

      case 0x3a: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        w[RD]!++;
        this.writedp(w[DP]!++, w[RD]!);
        w[RD]! += this.readdp(w[DP]!) << 8;
        this.writedp(w[DP]!, w[RD]! >> 8);
        r[FN]! = !!(w[RD]! & 0x8000) ? 1 : 0;
        r[FZ]! = (w[RD]! == 0) ? 1 : 0;
        break;
      }

      case 0x1a: {
        w[DP]! = this.readpc();
        w[RD]! = this.readdp(w[DP]!);
        w[RD]!--;
        this.writedp(w[DP]!++, w[RD]!);
        w[RD]! += this.readdp(w[DP]!) << 8;
        this.writedp(w[DP]!, w[RD]! >> 8);
        r[FN]! = !!(w[RD]! & 0x8000) ? 1 : 0;
        r[FZ]! = (w[RD]! == 0) ? 1 : 0;
        break;
      }

    }
  }
}
