/**
 * The machine the translated game code runs on: a 65816 register file, the full 128 KiB WRAM,
 * the ROM (data pack), the CPU I/O registers the game uses (multiply / divide, WRAM port, DMA,
 * joypads) and a video sink (VRAM, CGRAM, OAM) that the renderer reads. There is no CPU
 * interpreter here: the code runs as JavaScript compiled from the ROM (compile.ts).
 *
 * All state that a rollback must restore lives in one buffer (`state`), so a snapshot is one
 * copy. Registers are mirrored into it by save() / load().
 */
import type { RomImage } from '../rom.ts';

export const WRAM_SIZE = 0x20000;
const VRAM = WRAM_SIZE;
const CGRAM = VRAM + 0x10000;
const OAM = CGRAM + 0x200;
const IOREG = OAM + 0x220; // last byte written to each $2100-$21FF / $4200-$43FF register
const REGS = IOREG + 0x400;
const STATE_SIZE = REGS + 64;

export class Machine {
  readonly state = new Uint8Array(STATE_SIZE);
  readonly wram = this.state.subarray(0, WRAM_SIZE);
  readonly vram = this.state.subarray(VRAM, VRAM + 0x10000);
  readonly cgram = this.state.subarray(CGRAM, CGRAM + 0x200);
  readonly oam = this.state.subarray(OAM, OAM + 0x220);
  readonly ioreg = this.state.subarray(IOREG, IOREG + 0x400);
  readonly rom: RomImage;

  // registers
  a = 0;
  x = 0;
  y = 0;
  s = 0x1ff;
  d = 0;
  db = 0;
  pb = 0;
  // flags
  n = false;
  v = false;
  m = true;
  xf = true;
  dec = false;
  i = true;
  z = false;
  c = false;
  e = false;

  // I/O latches (saved in REGS)
  wmaddr = 0;
  vmaddr = 0;
  cgaddr = 0;
  oamaddr = 0;
  mulA = 0xff;
  rdmpy = 0;
  rddiv = 0;
  divDividend = 0xffff;
  /** joypad words read at $4218 + 2k (set by the host each frame) */
  readonly pads = new Uint16Array(4);
  /** HVBJOY ($4212) value the host wants reads to see */
  hvbjoy = 0;
  /** start of the block running now (diagnostics) */
  blockPc = 0;
  /** set by WAI; the frame runner stops there */
  waiting = false;
  /** ROM writes (the game should make none) */
  romWrites = 0;
  /** Sound commands sent to the driver this frame (command, parameter, ...), or null. */
  sound: number[] | null = [];
  /** Optional WRAM store log (fidelity tests): WRAM offset, byte, ... in program order. */
  log: number[] | null = null;

  constructor(rom: RomImage) {
    this.rom = rom;
  }

  // ---- bus ---------------------------------------------------------------------------------

  read8(addr: number): number {
    const bank = (addr >>> 16) & 0xff;
    const lo = addr & 0xffff;
    if (bank === 0x7e || bank === 0x7f) return this.wram[addr & 0x1ffff]!;
    if ((bank & 0x40) === 0) {
      if (lo < 0x2000) return this.wram[lo]!;
      if (lo < 0x8000) return this.ioRead(lo);
      return this.rom.fileU8(((bank & 0x3f) << 16) | lo);
    }
    return this.rom.fileU8(addr & 0x3fffff);
  }

  write8(addr: number, v: number): void {
    const bank = (addr >>> 16) & 0xff;
    const lo = addr & 0xffff;
    v &= 0xff;
    if (bank === 0x7e || bank === 0x7f) {
      this.wram[addr & 0x1ffff] = v;
      if (this.log !== null) this.log.push(addr & 0x1ffff, v);
    } else if ((bank & 0x40) === 0 && lo < 0x2000) {
      this.wram[lo] = v;
      if (this.log !== null) this.log.push(lo, v);
    } else if ((bank & 0x40) === 0 && lo < 0x8000) this.ioWrite(lo, v);
    else this.romWrites++;
  }

  /** 16-bit read; the high byte at addr + 1 with carry into the bank (absolute / long modes). */
  read16(addr: number): number {
    return this.read8(addr) | (this.read8((addr + 1) & 0xffffff) << 8);
  }

  /** 16-bit read in bank 0, wrapping at $FFFF (direct page, stack). */
  read16z(addr: number): number {
    return this.read8(addr & 0xffff) | (this.read8((addr + 1) & 0xffff) << 8);
  }

  read24z(addr: number): number {
    return this.read16z(addr) | (this.read8((addr + 2) & 0xffff) << 16);
  }

  write16(addr: number, v: number): void {
    this.write8(addr, v);
    this.write8((addr + 1) & 0xffffff, v >> 8);
  }

  write16z(addr: number, v: number): void {
    this.write8(addr & 0xffff, v);
    this.write8((addr + 1) & 0xffff, v >> 8);
  }

  /** Read of width w (8 / 16); z = bank-0 wrapping address. */
  rm(addr: number, w: number, z: boolean): number {
    if (w === 8) return this.read8(addr);
    return z ? this.read16z(addr) : this.read16(addr);
  }

  wm(addr: number, v: number, w: number, z: boolean): void {
    if (w === 8) this.write8(addr, v);
    else if (z) this.write16z(addr, v);
    else this.write16(addr, v);
  }

  // ---- stack -------------------------------------------------------------------------------

  push8(v: number): void {
    this.write8(this.s, v);
    this.s = (this.s - 1) & 0xffff;
  }

  push16(v: number): void {
    this.push8(v >> 8);
    this.push8(v);
  }

  pull8(): number {
    this.s = (this.s + 1) & 0xffff;
    return this.read8(this.s);
  }

  pull16(): number {
    const lo = this.pull8();
    return lo | (this.pull8() << 8);
  }

  // ---- flags -------------------------------------------------------------------------------

  get p(): number {
    return (
      (this.n ? 0x80 : 0) |
      (this.v ? 0x40 : 0) |
      (this.m ? 0x20 : 0) |
      (this.xf ? 0x10 : 0) |
      (this.dec ? 0x08 : 0) |
      (this.i ? 0x04 : 0) |
      (this.z ? 0x02 : 0) |
      (this.c ? 0x01 : 0)
    );
  }

  setP(p: number): void {
    this.n = (p & 0x80) !== 0;
    this.v = (p & 0x40) !== 0;
    this.m = (p & 0x20) !== 0;
    this.xf = (p & 0x10) !== 0;
    this.dec = (p & 0x08) !== 0;
    this.i = (p & 0x04) !== 0;
    this.z = (p & 0x02) !== 0;
    this.c = (p & 0x01) !== 0;
    if (this.xf) {
      this.x &= 0xff;
      this.y &= 0xff;
    }
  }

  rep(v: number): void {
    this.setP(this.p & ~v);
  }

  sep(v: number): void {
    this.setP(this.p | v);
  }

  nz(v: number, w: number): void {
    if (w === 8) {
      this.z = (v & 0xff) === 0;
      this.n = (v & 0x80) !== 0;
    } else {
      this.z = (v & 0xffff) === 0;
      this.n = (v & 0x8000) !== 0;
    }
  }

  // ---- ALU (w = 8 / 16) --------------------------------------------------------------------

  /** Set the accumulator (8-bit: low byte only, B kept). */
  setA(v: number, w: number): void {
    this.a = w === 8 ? (this.a & 0xff00) | (v & 0xff) : v & 0xffff;
    this.nz(v, w);
  }

  getA(w: number): number {
    return w === 8 ? this.a & 0xff : this.a;
  }

  ld(v: number, w: number): number {
    this.nz(v, w);
    return v;
  }

  ora(v: number, w: number): void {
    this.setA(this.getA(w) | v, w);
  }

  and(v: number, w: number): void {
    this.setA(this.getA(w) & v, w);
  }

  eor(v: number, w: number): void {
    this.setA(this.getA(w) ^ v, w);
  }

  /** ADC / SBC; SBC passes the complemented operand and sub = true (decimal: bsnes semantics). */
  private add(a: number, v: number, w: number, sub: boolean): void {
    let c = this.c ? 1 : 0;
    let r: number;
    if (!this.dec) {
      const mask = w === 8 ? 0xff : 0xffff;
      r = a + v + c;
      this.v = (~(a ^ v) & (a ^ r) & (w === 8 ? 0x80 : 0x8000)) !== 0;
      this.c = r > mask;
      this.setA(r & mask, w);
      return;
    }
    const digits = w === 8 ? 2 : 4;
    r = 0;
    for (let k = 0; k < digits; k++) {
      const sh = 4 * k;
      const lowMask = (1 << sh) - 1;
      r = (a & (0xf << sh)) + (v & (0xf << sh)) + (c << sh) + (r & lowMask);
      if (k === digits - 1) {
        this.v = (~(a ^ v) & (a ^ r) & (w === 8 ? 0x80 : 0x8000)) !== 0;
      }
      const lim = (0x10 << sh) - 1; // 0x0f, 0xff, 0xfff, 0xffff
      if (sub) {
        if (r <= lim) r -= 6 << sh;
      } else if (r > (0x0a << sh) - 1) {
        r += 6 << sh;
      }
      c = r > lim ? 1 : 0;
    }
    this.c = c === 1;
    this.setA(r & (w === 8 ? 0xff : 0xffff), w);
  }

  adc(v: number, w: number): void {
    this.add(this.getA(w), v, w, false);
  }

  sbc(v: number, w: number): void {
    this.add(this.getA(w), ~v & (w === 8 ? 0xff : 0xffff), w, true);
  }

  cmp(reg: number, v: number, w: number): void {
    const mask = w === 8 ? 0xff : 0xffff;
    const r = (reg & mask) - v;
    this.c = r >= 0;
    this.nz(r, w);
  }

  bit(v: number, w: number, imm: boolean): void {
    this.z = (this.getA(w) & v) === 0;
    if (!imm) {
      this.n = (v & (w === 8 ? 0x80 : 0x8000)) !== 0;
      this.v = (v & (w === 8 ? 0x40 : 0x4000)) !== 0;
    }
  }

  asl(v: number, w: number): number {
    const mask = w === 8 ? 0xff : 0xffff;
    this.c = (v & (w === 8 ? 0x80 : 0x8000)) !== 0;
    const r = (v << 1) & mask;
    this.nz(r, w);
    return r;
  }

  lsr(v: number, w: number): number {
    this.c = (v & 1) !== 0;
    const r = v >> 1;
    this.nz(r, w);
    return r;
  }

  rol(v: number, w: number): number {
    const mask = w === 8 ? 0xff : 0xffff;
    const r = ((v << 1) | (this.c ? 1 : 0)) & mask;
    this.c = (v & (w === 8 ? 0x80 : 0x8000)) !== 0;
    this.nz(r, w);
    return r;
  }

  ror(v: number, w: number): number {
    const r = (v >> 1) | (this.c ? (w === 8 ? 0x80 : 0x8000) : 0);
    this.c = (v & 1) !== 0;
    this.nz(r, w);
    return r;
  }

  inc(v: number, w: number): number {
    const r = (v + 1) & (w === 8 ? 0xff : 0xffff);
    this.nz(r, w);
    return r;
  }

  dec_(v: number, w: number): number {
    const r = (v - 1) & (w === 8 ? 0xff : 0xffff);
    this.nz(r, w);
    return r;
  }

  tsb(v: number, w: number): number {
    const a = this.getA(w);
    this.z = (a & v) === 0;
    return v | a;
  }

  trb(v: number, w: number): number {
    const a = this.getA(w);
    this.z = (a & v) === 0;
    return v & ~a & (w === 8 ? 0xff : 0xffff);
  }

  /** MVN (step +1) / MVP (step -1): moves A + 1 bytes; DB = destination bank. */
  move(dstBank: number, srcBank: number, step: number): void {
    this.db = dstBank;
    const xmask = this.xf ? 0xff : 0xffff;
    do {
      this.write8((dstBank << 16) | this.y, this.read8((srcBank << 16) | this.x));
      this.x = (this.x + step) & xmask;
      this.y = (this.y + step) & xmask;
      this.a = (this.a - 1) & 0xffff;
    } while (this.a !== 0xffff);
  }

  // ---- I/O ---------------------------------------------------------------------------------

  /**
   * APU ports $2140-$2143, high-level stand-in for the SPC700 until the real driver runs in an
   * SPC emulator: it answers the IPL upload handshake (AA BB, key echo) and acknowledges every
   * sound command at once (port 2 reads the sequence byte $03C5 the game waits for). Mode in
   * ioreg[0x1f0]: 0 IPL, 1 transfer, 2 driver.
   */
  private apuRead(port: number): number {
    const mode = this.ioreg[0x1f0]!;
    if (mode === 0 && port < 2) return port === 0 ? 0xaa : 0xbb;
    // driver: port 2 is the command acknowledge; a fresh driver reports 1 (C00BF7 waits for it)
    if (mode === 2 && port === 2) return this.ioreg[0x1f2] ? 1 : this.wram[0x03c5]!;
    return this.ioreg[0x40 + port]!;
  }

  private apuWrite(port: number, v: number): void {
    if (port !== 0) return;
    const mode = this.ioreg[0x1f0]!;
    if (mode === 0) {
      if (v === 0xcc) {
        this.ioreg[0x1f0] = 1; // IPL: first block
        this.ioreg[0x1f1] = 0;
      }
    } else if (mode === 1) {
      if (v === this.ioreg[0x1f1]) {
        this.ioreg[0x1f1] = (v + 1) & 0xff; // data byte: the IPL echoes the counter
      } else if (this.ioreg[0x41] === 0) {
        this.ioreg[0x1f0] = 2; // a key with port 1 = 0: jump to the uploaded driver
        this.ioreg[0x1f2] = 1;
      } else {
        this.ioreg[0x1f1] = 0; // a key with port 1 != 0: next block
      }
    } else if (v === 0xf9 || v === 0xfa) {
      this.ioreg[0x1f0] = 0; // the driver hands control back to the IPL for an upload
      this.ioreg[0x1f2] = 0;
    } else {
      this.ioreg[0x1f2] = 0;
      if (this.sound !== null) this.sound.push(v, this.ioreg[0x41]!);
    }
  }

  /**
   * Serial joypad reads ($4016 port 1, $4017 port 2, data line D0): the pad's 16 bits (B first)
   * after a latch, then 1s, which is how the game detects a connected standard pad. No
   * multitap (D1 reads 0). Bit counters in ioreg[0x1f4 + port]; 16 after the auto-read.
   */
  private serialRead(port: number): number {
    const k = this.ioreg[0x1f4 + port]!;
    const bit = k < 16 ? (this.pads[port]! >> (15 - k)) & 1 : 1;
    if (k < 16) this.ioreg[0x1f4 + port] = k + 1;
    return port === 0 ? bit : 0x1c | bit;
  }

  /** The auto-joypad read at the start of a frame clocks the 16 bits out. */
  autoJoypad(): void {
    this.ioreg[0x1f4] = 16;
    this.ioreg[0x1f5] = 16;
  }

  private ioRead(lo: number): number {
    if (lo >= 0x2140 && lo < 0x2180) return this.apuRead(lo & 3);
    if (lo === 0x4016 || lo === 0x4017) return this.serialRead(lo - 0x4016);
    switch (lo) {
      case 0x2180: {
        const v = this.wram[this.wmaddr]!;
        this.wmaddr = (this.wmaddr + 1) & 0x1ffff;
        return v;
      }
      case 0x4210:
        return 0x02; // RDNMI: CPU version 2, NMI flag clear
      case 0x4211:
        return 0x80; // TIMEUP: the IRQ the handler acknowledges
      case 0x4212:
        // HVBJOY: auto-read never busy; H-blank toggles on each read so both kinds of wait end
        this.hvbjoy ^= 0x40;
        return 0x80 | this.hvbjoy;
      case 0x4214:
        return this.rddiv & 0xff;
      case 0x4215:
        return this.rddiv >> 8;
      case 0x4216:
        return this.rdmpy & 0xff;
      case 0x4217:
        return this.rdmpy >> 8;
      default:
        if (lo >= 0x4218 && lo < 0x4220) {
          const p = this.pads[(lo - 0x4218) >> 1]!;
          return lo & 1 ? p >> 8 : p & 0xff;
        }
        if (lo >= 0x4300 && lo < 0x4380) return this.ioreg[0x200 + (lo - 0x4200)]!;
        return 0;
    }
  }

  private ioWrite(lo: number, v: number): void {
    if (lo >= 0x2140 && lo < 0x2180) lo = 0x2140 | (lo & 3);
    if (lo >= 0x2100 && lo < 0x2200) this.ioreg[lo - 0x2100] = v;
    else if (lo >= 0x4200 && lo < 0x4400) this.ioreg[0x200 + (lo - 0x4200)] = v;
    if (lo >= 0x2140 && lo < 0x2144) {
      this.apuWrite(lo & 3, v);
      return;
    }
    switch (lo) {
      case 0x2102:
        this.oamaddr = (v | ((this.ioreg[3]! & 1) << 8)) << 1;
        break;
      case 0x2103:
        this.oamaddr = (this.ioreg[2]! | ((v & 1) << 8)) << 1;
        break;
      case 0x2104:
        this.oam[this.oamaddr % 0x220] = v;
        this.oamaddr = (this.oamaddr + 1) % 0x220;
        break;
      case 0x2116:
      case 0x2117:
        this.vmaddr = this.ioreg[0x16]! | (this.ioreg[0x17]! << 8);
        break;
      case 0x2118:
      case 0x2119: {
        this.vram[((this.vmaddr << 1) | (lo & 1)) & 0xffff] = v;
        const highStep = (this.ioreg[0x15]! & 0x80) !== 0;
        if ((lo === 0x2119) === highStep) {
          const inc = [1, 32, 128, 128][this.ioreg[0x15]! & 3]!;
          this.vmaddr = (this.vmaddr + inc) & 0x7fff;
        }
        break;
      }
      case 0x2121:
        this.cgaddr = v << 1;
        break;
      case 0x2122:
        this.cgram[this.cgaddr & 0x1ff] = v;
        this.cgaddr = (this.cgaddr + 1) & 0x1ff;
        break;
      case 0x2180:
        this.wram[this.wmaddr] = v;
        if (this.log !== null) this.log.push(this.wmaddr, v);
        this.wmaddr = (this.wmaddr + 1) & 0x1ffff;
        break;
      case 0x2181:
      case 0x2182:
      case 0x2183:
        this.wmaddr = (this.ioreg[0x81]! | (this.ioreg[0x82]! << 8) | ((this.ioreg[0x83]! & 1) << 16)) & 0x1ffff;
        break;
      case 0x4016:
        if (v & 1) {
          this.ioreg[0x1f4] = 0; // latch: the next reads start at bit 15 (B)
          this.ioreg[0x1f5] = 0;
        }
        break;
      case 0x4202:
        this.mulA = v;
        break;
      case 0x4203:
        this.rdmpy = this.mulA * v;
        break;
      case 0x4204:
      case 0x4205:
        this.divDividend = this.ioreg[0x204]! | (this.ioreg[0x205]! << 8);
        break;
      case 0x4206:
        if (v === 0) {
          this.rddiv = 0xffff;
          this.rdmpy = this.divDividend;
        } else {
          this.rddiv = Math.trunc(this.divDividend / v);
          this.rdmpy = this.divDividend % v;
        }
        break;
      case 0x420b:
        this.dma(v);
        break;
    }
  }

  /** General DMA on the channels set in `mask` (A-bus <-> B-bus $21xx). */
  private dma(mask: number): void {
    for (let ch = 0; ch < 8; ch++) {
      if (!(mask & (1 << ch))) continue;
      const r = 0x300 + 16 * ch; // ioreg offset of $43x0
      const ctrl = this.ioreg[r]!;
      const bReg = 0x2100 | this.ioreg[r + 1]!;
      let src = this.ioreg[r + 2]! | (this.ioreg[r + 3]! << 8);
      const bank = this.ioreg[r + 4]!;
      let count = this.ioreg[r + 5]! | (this.ioreg[r + 6]! << 8);
      if (count === 0) count = 0x10000;
      const pattern = [[0], [0, 1], [0, 0], [0, 0, 1, 1], [0, 1, 2, 3], [0, 1, 0, 1], [0, 0], [0, 0, 1, 1]][ctrl & 7]!;
      const fixed = (ctrl & 0x08) !== 0;
      const step = ctrl & 0x10 ? -1 : 1;
      const toA = (ctrl & 0x80) !== 0;
      for (let k = 0; k < count; k++) {
        const b = bReg + pattern[k % pattern.length]!;
        const a = (bank << 16) | src;
        if (toA) this.write8(a, this.ioRead(b));
        else this.ioWrite(b, this.read8(a));
        if (!fixed) src = (src + step) & 0xffff;
      }
      this.ioreg[r + 2] = src & 0xff;
      this.ioreg[r + 3] = src >> 8;
      this.ioreg[r + 5] = 0;
      this.ioreg[r + 6] = 0;
    }
  }

  // ---- snapshots ---------------------------------------------------------------------------

  private regWords(): number[] {
    return [this.a, this.x, this.y, this.s, this.d, this.db, this.pb, this.p | (this.e ? 0x100 : 0),
      this.wmaddr & 0xffff, this.wmaddr >> 16, this.vmaddr, this.cgaddr, this.oamaddr, this.mulA,
      this.rdmpy, this.rddiv, this.divDividend];
  }

  save(): Uint8Array {
    const dv = new DataView(this.state.buffer, this.state.byteOffset + REGS, 64);
    this.regWords().forEach((w, k) => dv.setUint16(2 * k, w, true));
    return this.state.slice();
  }

  load(snap: Uint8Array): void {
    this.state.set(snap);
    const dv = new DataView(this.state.buffer, this.state.byteOffset + REGS, 64);
    const w = (k: number) => dv.getUint16(2 * k, true);
    this.a = w(0);
    this.x = w(1);
    this.y = w(2);
    this.s = w(3);
    this.d = w(4);
    this.db = w(5);
    this.pb = w(6);
    this.setP(w(7) & 0xff);
    this.e = (w(7) & 0x100) !== 0;
    this.wmaddr = w(8) | (w(9) << 16);
    this.vmaddr = w(10);
    this.cgaddr = w(11);
    this.oamaddr = w(12);
    this.mulA = w(13);
    this.rdmpy = w(14);
    this.rddiv = w(15);
    this.divDividend = w(16);
  }
}

/** FNV-1a 32-bit: the desync checksum of a saved state. */
export function checksum(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
