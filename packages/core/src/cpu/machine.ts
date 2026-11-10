/**
 * The machine the translated game code runs on: a 65816 register file, the full 128 KiB WRAM,
 * the ROM (data pack), the CPU I/O registers the game uses (multiply / divide, WRAM port, DMA
 * and HDMA, H/V timer IRQ, joypads), a video sink (VRAM, CGRAM, OAM) that the renderer
 * reads, and the sound unit (apu/). There is no CPU interpreter here: the code runs as JavaScript compiled from the ROM
 * (compile.ts).
 *
 * Timing (timing.ts): every bus access costs the master clocks of its memory region and the
 * translated code adds the opcode fetches and internal cycles, so `cyc` / `v` follow the
 * scanline the hardware would be on. `brk` is where the translated code must stop at an
 * instruction boundary: the next timer IRQ, or STOP.
 *
 * All state that a rollback must restore lives in one buffer (`state`), so a snapshot is one
 * copy. Registers are mirrored into it by save() / load().
 *
 * One extension beyond the SNES, for game modes (the original never uses it, checked over its
 * VMAIN writes): two more sprite banks. `objx` holds two banks of 512 sprite tiles each, laid
 * out as the sprite tables are (tile n at n * 32; bank 2 from 0x4000); with VMAIN ($2115) bit 6
 * set, VRAM writes into the sprite tables go to bank 1 instead of VRAM, with bit 5 to bank 2.
 * An OAM entry whose `oamx` byte has bit 0 (bank 1) or bit 2 (bank 2) takes its tiles from that
 * bank, and its colors from the bank's own sprite palettes (`cgramx`: bank 1, then bank 2).
 * Modes set `oamxNext` while the frame builds the OAM; a DMA of the whole OAM commits it to
 * `oamx`, so the flags change with the entries they describe.
 *
 * And more sprites: `oamExt` is a second OAM (128 entries, the same layout as the OAM, drawn
 * after it, so below it), of which the first `oamExtCount` are shown; modes fill `oamExtNext`
 * and `oamExtCountNext`, committed with the OAM (entries 128-255 of `oamx` / `oamWideX`).
 *
 * And HUD panels beside the SNES screen (`hudx`): with `hudxRows` set, the renderer draws a
 * left and a right panel of BG3 tiles in the wide picture's margins (9 columns each), on the
 * BG3 tile rows `hudxRow` .. + hudxRows, moved as the HUD is. Panel entries are BG3 map
 * entries; tiles 3C0-3FF come from the panels' own 64 tiles (`hudxTiles`, 2 bpp), and the
 * colours from CGRAM or (margins flag) from the panels' own eight palettes (`hudxPalettes`).
 *
 * And what the margins of a wide picture show (`margins`), for screens whose maps do not go
 * on beyond the 256 columns: per BG layer, its map as it is (the default), nothing, or a
 * repeated patch of the layer as it shows on the screen (`Margin`); and whether sprites
 * without a real x stay inside the 256 columns.
 *
 * And more work RAM: with `ramExt` (set by a mode before the game runs), 6000-7FFF of banks
 * 00-3F / 80-BF (unmapped on this cartridge) reach WRAM 7E:6000-7FFF, which the game never
 * uses, so direct-page code can run on objects there.
 *
 * Another: `overclock` (see tick), a faster CPU against the same video timing.
 *
 * And a wider picture: `wide` is how many pixels a mode shows beyond each side of the 256
 * (0 = the SNES). Sprites out there do not fit the OAM's 9-bit x, so a mode also gives an
 * entry its real x (`oamWideX`, signed, flagged by `oamx` bit 1), committed with the flags.
 * And a taller one: `tall` (see there).
 */
import { APU_STATE_SIZE, Apu } from '../apu/apu.ts';
import type { RomImage } from '../rom.ts';
import { DMA_SYNC, Ev, H_MAX, MODE_OFFSETS, NEVER, STOP, hEvent, hvbjoy, updateIrq } from './timing.ts';

export const WRAM_SIZE = 0x20000;
const VRAM = WRAM_SIZE;
const CGRAM = VRAM + 0x10000;
const OAM = CGRAM + 0x200;
const IOREG = OAM + 0x220; // last byte written to each $2100-$21FF / $4200-$43FF register
const PPU = IOREG + 0x400;
const REGS = PPU + 2 * 16;
const REG_WORDS = 48;
const OBJX = REGS + 4 * REG_WORDS;
const OAMX = OBJX + 0x8000;
const OAMX_NEXT = OAMX + 0x100;
const CGRAMX = OAMX_NEXT + 0x100;
const OAM_WIDE_X = CGRAMX + 0x200;
const OAM_WIDE_X_NEXT = OAM_WIDE_X + 0x200;
const OAM_EXT = OAM_WIDE_X_NEXT + 0x200;
const OAM_EXT_NEXT = OAM_EXT + 0x220;
/** HUD panels (extension): rows and columns of each, and the first tile of the panels' own */
export const HUDX_ROWS = 28;
export const HUDX_COLS = 9;
export const HUDX_TILE0 = 0x3c0;
const HUDX_MAP_BYTES = 2 * HUDX_ROWS * HUDX_COLS * 2;
const HUDX_TILES = OAM_EXT_NEXT + 0x220;
const HUDX_MAP = HUDX_TILES + 0x400;
const HUDX_PALETTES = HUDX_MAP + HUDX_MAP_BYTES;
const MARGINS = HUDX_PALETTES + 0x40;
const RULES_BYTES = MARGINS + 2 * 16;
const APU = RULES_BYTES + 32;
/**
 * What the wide picture's margins show (Machine.margins): per BG layer (BG1-BG3, `MARGIN_WORDS`
 * words each) its mode, then the source patch; the last word is the sprite flags.
 */
export const Margin = {
  /** the layer's map goes on (the default) */
  MAP: 0,
  /** the layer is not drawn in the margins */
  OFF: 1,
  /** the margins repeat a patch of the layer as it shows on the SNES screen */
  REPEAT: 2,
} as const;
export const MARGIN_WORDS = 5;
/**
 * Machine.margins[MARGIN_SPRITES] bit 0: sprites without a real x stay on the SNES screen;
 * bit 1: the HUD panels take their colours from their own palettes (`hudxPalettes`)
 */
export const MARGIN_SPRITES = 15;
/** the second sprite bank in objx */
export const OBJX_BANK2 = 0x4000;
/** the WRAM that ramExt maps into banks 00-3F / 80-BF */
export const RAM_EXT = [0x6000, 0x8000] as const;
const STATE_SIZE = APU + APU_STATE_SIZE;

/** PPU registers that are more than their last written byte (Machine.ppu, 16-bit words). */
export const PpuReg = {
  /** BG1-BG4 horizontal / vertical scroll (10 bits), $210D-$2114 */
  HOFS: 0,
  VOFS: 4,
  /** the previous byte written to a scroll register (shared latch) */
  OFS_LATCH: 8,
  /** Mode 7 matrix A / B ($211B / $211C), for the multiplier at $2134-$2136 */
  M7A: 9,
  M7B: 10,
  /** the previous byte written to a Mode 7 register (shared latch) */
  M7_LATCH: 11,
  /** fixed color ($2132), 5 bits each */
  FIXED_R: 12,
  FIXED_G: 13,
  FIXED_B: 14,
  /** highest brightness of the frame (the oracle chooses its color-math path by it) */
  MAX_BRIGHTNESS: 15,
} as const;

/** I-flag change that CLI / SEI make at the next instruction boundary (after the IRQ check). */
export const IChange = { None: 0, Clear: 1, Set: 2 } as const;
export type IChange = (typeof IChange)[keyof typeof IChange];

export class Machine {
  readonly state = new Uint8Array(STATE_SIZE);
  readonly wram = this.state.subarray(0, WRAM_SIZE);
  readonly vram = this.state.subarray(VRAM, VRAM + 0x10000);
  readonly cgram = this.state.subarray(CGRAM, CGRAM + 0x200);
  readonly oam = this.state.subarray(OAM, OAM + 0x220);
  readonly ioreg = this.state.subarray(IOREG, IOREG + 0x400);
  /** PPU register state beyond ioreg (PpuReg); little-endian words in the state buffer */
  readonly ppu = new Uint16Array(this.state.buffer, PPU, 16);
  /** the extra sprite banks (extension): 512 tiles each, tile n at n * 32, bank 2 at OBJX_BANK2 */
  readonly objx = this.state.subarray(OBJX, OBJX + 0x8000);
  /**
   * per OAM entry (0-127, then oamExt's 128-255): bit 0 = its tiles come from bank 1, bit 2 =
   * from bank 2, bit 1 = it has a real x (extension); set by the next full OAM DMA
   */
  readonly oamx = this.state.subarray(OAMX, OAMX + 0x100);
  readonly oamxNext = this.state.subarray(OAMX_NEXT, OAMX_NEXT + 0x100);
  /** the banks' own sprite palettes (extension): 8 x 16 colors each, as CGRAM 80-FF; bank 2 at 0x100 */
  readonly cgramx = this.state.subarray(CGRAMX, CGRAMX + 0x200);
  /** per OAM entry, its real x (extension, `oamx` bit 1): int16 little-endian; and the next */
  readonly oamWideX = new Int16Array(this.state.buffer, this.state.byteOffset + OAM_WIDE_X, 0x100);
  readonly oamWideXNext = new Int16Array(this.state.buffer, this.state.byteOffset + OAM_WIDE_X_NEXT, 0x100);
  /** the second OAM (extension): 128 entries as the OAM (low table, then high table); and the next */
  readonly oamExt = this.state.subarray(OAM_EXT, OAM_EXT + 0x220);
  readonly oamExtNext = this.state.subarray(OAM_EXT_NEXT, OAM_EXT_NEXT + 0x220);
  /** entries of oamExt shown (0 = none); and the next */
  oamExtCount = 0;
  oamExtCountNext = 0;
  /** the HUD panels' tiles (extension): 64 2bpp tiles, numbered HUDX_TILE0 .. in panel entries */
  readonly hudxTiles = this.state.subarray(HUDX_TILES, HUDX_TILES + 0x400);
  /** the HUD panels (extension): left then right, HUDX_ROWS x HUDX_COLS BG3 map entries each */
  readonly hudxMap = this.state.subarray(HUDX_MAP, HUDX_MAP + HUDX_MAP_BYTES);
  /** the HUD panels' own palettes (extension): 8 x 4 BGR555 colours, as BG3's in CGRAM */
  readonly hudxPalettes = this.state.subarray(HUDX_PALETTES, HUDX_PALETTES + 0x40);
  /** panel rows shown (0 = none), from BG3 tile row hudxRow */
  hudxRows = 0;
  hudxRow = 0;
  /**
   * The margins (extension, `Margin`): for BG layer n, words 5n .. 5n + 4 are its mode and the
   * patch a REPEAT layer shows: x, width, y, height in screen pixels (x 0-255, y 0-223, the
   * patch inside the screen); word MARGIN_SPRITES holds the sprite flags. All 0: the default.
   */
  readonly margins = new Int16Array(this.state.buffer, this.state.byteOffset + MARGINS, 16);
  /** 6000-7FFF of banks 00-3F / 80-BF reach WRAM (extension; config, not state) */
  ramExt = false;
  /** pixels shown beyond each side of the 256 (extension; 0 = the SNES picture) */
  wide = 0;
  /**
   * The line where the game's picture ends (extension; 0 = the SNES picture): the renderer fills
   * the lines above the first drawn one, and from this one down, with the picture.
   */
  tall = 0;
  /**
   * With `tall`, the HUD (BG3) moves to the new edges (extension): BG3 lines before `hudTop`
   * rise `hudLift` lines, lines from `hudBottom` on drop `hudDrop` lines.
   */
  hudTop = 0;
  hudLift = 0;
  hudBottom = 0;
  hudDrop = 0;
  /**
   * A word the game modes own (extension): saved and restored with the state, never read by
   * the core. (packages/rules: the Game Mode Select's choice.)
   */
  rulesWord = 0;
  /** more state the game modes own (extension), never read by the core */
  readonly rulesBytes = this.state.subarray(RULES_BYTES, RULES_BYTES + 32);
  /** the sound unit (SPC700 + DSP), its state in the same buffer */
  readonly apu = new Apu(this.state.subarray(APU, STATE_SIZE));
  readonly rom: RomImage;

  // registers
  a = 0;
  x = 0;
  y = 0;
  s = 0x1ff;
  d = 0;
  db = 0;
  pb = 0;
  /** where execution continues (the Game's program counter, PB included) */
  pc = 0;
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

  // timing (saved)
  /** master clocks into the current scanline */
  cyc = 0;
  /** scanline (V counter) */
  vline = 0;
  /** length of this line in master clocks */
  hMax = H_MAX;
  /** next fixed event of the line and its position */
  event = 0;
  hNext = 0;
  /** DRAM refresh position of this line (534 / 538) */
  refresh = 538;
  /** field bit ($213F bit 7): toggles each frame */
  field = 0;
  /** next H/V timer IRQ, in clocks relative to the current line (NEVER: none) */
  irqAt = NEVER;
  /** the timer IRQ is asserted (until TIMEUP is read) */
  irqLine = false;
  /** pending CLI / SEI */
  iChange: IChange = IChange.None;
  /** WAI executed, waiting for an interrupt */
  waiting = false;
  /** memory speed of FastROM banks (MEMSEL $420D) */
  fast = 8;
  /** RDNMI flag (bit 7) */
  nmiFlag = 0;
  /** HDMA channels active this frame, and those whose table ended */
  hdma = 0;
  hdmaEnded = 0;
  /** frames completed */
  frames = 0;

  // timing (not saved: valid only while a frame runs)
  /** the translated code stops at an instruction boundary once cyc >= brk */
  brk = NEVER;
  /** line 225 began: the frame is over at the next instruction boundary */
  frameDone = false;

  // I/O latches (saved)
  wmaddr = 0;
  vmaddr = 0;
  cgaddr = 0;
  oamaddr = 0;
  mulA = 0xff;
  rdmpy = 0;
  rddiv = 0;
  divDividend = 0xffff;

  /** the pad words (SNES layout, pads 1-5) the controllers hold now (set by the host) */
  readonly pads = new Uint16Array(5);
  /**
   * Players 5-8's pad words (extension, SNES layout, set by the host with the pads): no port
   * reads them; game modes give them to wrestlers of their own.
   */
  readonly padsx = new Uint16Array(4);
  /** start of the block running now (diagnostics) */
  blockPc = 0;
  /** the renderer: called for each visible line (0-223) when the beam reaches it */
  onLine: ((y: number) => void) | null = null;
  /** called before each instruction when the translator is `hooked` (diagnostics) */
  hook: (pc: number) => void = () => {};
  /** ROM writes (the game should make none) */
  romWrites = 0;
  /** Optional WRAM store log (fidelity tests): WRAM offset, byte, ... in program order. */
  log: number[] | null = null;

  constructor(rom: RomImage) {
    this.rom = rom;
  }

  // ---- clock -------------------------------------------------------------------------------

  /**
   * CPU overclock (extension, for game modes; 0 = the SNES): the CPU and its DMA spend
   * n >> overclock clocks (rounded up), so the game gets 2^overclock times the work per frame.
   * The line events (HDMA, refresh, interrupts) keep the SNES timing.
   */
  overclock = 0;

  /** Spend n master clocks, running the line events they pass. */
  tick(n: number): void {
    this.cyc += (n + (1 << this.overclock) - 1) >> this.overclock;
    while (this.cyc >= this.hNext) hEvent(this);
  }

  /** Master clocks of one bus access at addr (snes9x memory_speed). */
  speed(addr: number): number {
    if (addr & 0x408000) return addr & 0x800000 ? this.fast : 8;
    if ((addr + 0x6000) & 0x4000) return 8;
    if ((addr - 0x4000) & 0x7e00) return 6;
    return 12;
  }

  /** Stop the translated code at the next instruction boundary. */
  stop(): void {
    this.brk = STOP;
  }

  /** Line 0 just after the jump to the reset vector (the oracle's power-on state). */
  resetTiming(): void {
    this.cyc = 198;
    this.vline = 0;
    this.hMax = H_MAX;
    this.event = Ev.Render;
    this.hNext = 512;
    this.refresh = 538;
    this.field = 0;
    this.irqAt = NEVER;
    this.irqLine = false;
    this.iChange = IChange.None;
    this.waiting = false;
    this.fast = 8;
    this.nmiFlag = 0;
    this.hdma = 0;
    this.hdmaEnded = 0;
    this.brk = NEVER;
    this.frameDone = false;
  }

  // ---- bus ---------------------------------------------------------------------------------

  /** Read without spending time (DMA, HDMA, the translator). */
  peek8(addr: number): number {
    const bank = (addr >>> 16) & 0xff;
    const lo = addr & 0xffff;
    if (bank === 0x7e || bank === 0x7f) return this.wram[addr & 0x1ffff]!;
    if ((bank & 0x40) === 0) {
      if (lo < 0x2000) return this.wram[lo]!;
      if (lo >= 0x6000 && lo < 0x8000 && this.ramExt) return this.wram[lo]!;
      if (lo < 0x8000) return this.ioRead(lo);
      return this.rom.fileU8(((bank & 0x3f) << 16) | lo);
    }
    return this.rom.fileU8(addr & 0x3fffff);
  }

  /** Write without spending time. */
  poke8(addr: number, v: number): void {
    const bank = (addr >>> 16) & 0xff;
    const lo = addr & 0xffff;
    v &= 0xff;
    if (bank === 0x7e || bank === 0x7f) {
      this.wram[addr & 0x1ffff] = v;
      if (this.log !== null) this.log.push(addr & 0x1ffff, v);
    } else if ((bank & 0x40) === 0 && (lo < 0x2000 || (lo >= 0x6000 && lo < 0x8000 && this.ramExt))) {
      this.wram[lo] = v;
      if (this.log !== null) this.log.push(lo, v);
    } else if ((bank & 0x40) === 0 && lo < 0x8000) this.ioWrite(lo, v);
    else this.romWrites++;
  }

  read8(addr: number): number {
    const v = this.peek8(addr);
    this.tick(this.speed(addr));
    return v;
  }

  write8(addr: number, v: number): void {
    this.poke8(addr, v);
    this.tick(this.speed(addr));
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

  /**
   * Indexed effective address base + index: an extra internal cycle when the index is 16-bit,
   * for writes, or when the low byte carries into the next page.
   */
  indexed(base: number, index: number, always: boolean): number {
    if (always || (base & 0xff) + (index & 0xff) >= 0x100) this.tick(6);
    return (base + index) & 0xffffff;
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
    if (this.irqLine && !this.i) this.stop(); // a pending IRQ is taken after this instruction
  }

  rep(v: number): void {
    this.setP(this.p & ~v);
  }

  sep(v: number): void {
    this.setP(this.p | v);
  }

  /** CLI / SEI: the flag changes at the next boundary, after that boundary's IRQ check. */
  changeI(change: IChange): void {
    this.iChange = change;
    this.stop();
  }

  applyIChange(): void {
    if (this.iChange === IChange.Clear) this.i = false;
    else if (this.iChange === IChange.Set) this.i = true;
    this.iChange = IChange.None;
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

  /**
   * One byte of MVN (step +1) / MVP (step -1); the instruction repeats until A wraps to $FFFF.
   * DB = destination bank. Returns true when the move is complete.
   */
  moveByte(dstBank: number, srcBank: number, step: number): boolean {
    this.db = dstBank;
    const xmask = this.xf ? 0xff : 0xffff;
    this.write8((dstBank << 16) | this.y, this.read8((srcBank << 16) | this.x));
    this.x = (this.x + step) & xmask;
    this.y = (this.y + step) & xmask;
    this.a = (this.a - 1) & 0xffff;
    this.tick(12);
    return this.a === 0xffff;
  }

  // ---- I/O ---------------------------------------------------------------------------------

  /**
   * Serial joypad reads ($4016 port 1, $4017 port 2, data line D0): the pad's 16 bits (B first)
   * after a latch, then 1s, which is how the game detects a connected standard pad. Bit
   * counters in ioreg[0x1f4 + port]; 16 after the auto-read.
   *
   * A multitap in port 2 (`multitap`, snes9x MP5, pads 2-5): while the latch ($4016 bit 0,
   * kept in ioreg[0x1f6]) is high port 2 reads D1 = 1 (how the game detects it); then each
   * read gives one bit of two pads, D0 and D1: pads 2 / 3 while IOBIT ($4201 bit 7) is 1,
   * pads 4 / 5 while it is 0, each pair with its own counter (ioreg[0x1f5] / ioreg[0x1f7]).
   */
  private serialRead(port: number): number {
    if (port === 1 && this.multitap) {
      const bits = 0x1c;
      if (this.ioreg[0x1f6]! & 1) return bits | 2;
      const iobit = (this.ioreg[0x201]! & 0x80) !== 0;
      const at = iobit ? 0x1f5 : 0x1f7;
      const r = this.ioreg[at]!;
      if (r < 255) this.ioreg[at] = r + 1;
      const first = iobit ? 1 : 3;
      let out = bits;
      for (let i = 0; i < 2; i++) out |= (r >= 16 ? 1 : (this.pads[first + i]! >> (15 - r)) & 1) << i;
      return out;
    }
    const k = this.ioreg[0x1f4 + port]!;
    const bit = k < 16 ? (this.pads[port]! >> (15 - k)) & 1 : 1;
    if (k < 16) this.ioreg[0x1f4 + port] = k + 1;
    return port === 0 ? bit : 0x1c | bit;
  }

  /** A multitap in controller port 2 (state: ioreg[0x1f8]). */
  get multitap(): boolean {
    return this.ioreg[0x1f8] !== 0;
  }
  set multitap(on: boolean) {
    this.ioreg[0x1f8] = on ? 1 : 0;
  }

  /**
   * The auto-joypad read (line 227): latches the pads into $4218-$421F, clocks the 16 bits out.
   * With the multitap, port 2 gives the pair IOBIT selects ($421A / $421E).
   */
  autoJoypad(): void {
    if (this.multitap) {
      const iobit = (this.ioreg[0x201]! & 0x80) !== 0;
      const words = [this.pads[0]!, iobit ? this.pads[1]! : this.pads[3]!, 0, iobit ? this.pads[2]! : this.pads[4]!];
      for (let k = 0; k < 4; k++) {
        this.ioreg[0x218 + 2 * k] = words[k]! & 0xff;
        this.ioreg[0x219 + 2 * k] = words[k]! >> 8;
      }
      this.ioreg[0x1f4] = 16;
      this.ioreg[iobit ? 0x1f5 : 0x1f7] = 16;
      return;
    }
    for (let k = 0; k < 4; k++) {
      this.ioreg[0x218 + 2 * k] = this.pads[k]! & 0xff;
      this.ioreg[0x219 + 2 * k] = this.pads[k]! >> 8;
    }
    this.ioreg[0x1f4] = 16;
    this.ioreg[0x1f5] = 16;
  }

  ioRead(lo: number): number {
    if (lo >= 0x2140 && lo < 0x2180) return this.apu.read(lo & 3, this.cyc);
    if (lo === 0x4016 || lo === 0x4017) return this.serialRead(lo - 0x4016);
    switch (lo) {
      case 0x2180: {
        const v = this.wram[this.wmaddr]!;
        this.wmaddr = (this.wmaddr + 1) & 0x1ffff;
        return v;
      }
      case 0x2134:
      case 0x2135:
      case 0x2136: {
        // MPYL/M/H: signed 16-bit M7A times the signed high byte of M7B
        const a = (this.ppu[PpuReg.M7A]! << 16) >> 16;
        const b = (this.ppu[PpuReg.M7B]! << 16) >> 24;
        return ((a * b) >> (8 * (lo - 0x2134))) & 0xff;
      }
      case 0x4210: {
        const f = this.nmiFlag;
        this.nmiFlag = 0;
        return f | 0x02; // RDNMI: CPU version 2
      }
      case 0x4211: {
        // TIMEUP: reading acknowledges the IRQ (and sees one whose time came mid-instruction)
        if (!this.irqLine && this.irqAt !== NEVER && this.cyc >= this.irqAt) {
          updateIrq(this, false);
          this.irqLine = true;
        }
        const up = this.irqLine ? 0x80 : 0;
        this.irqLine = false;
        return up;
      }
      case 0x4212:
        return hvbjoy(this);
      case 0x4214:
        return this.rddiv & 0xff;
      case 0x4215:
        return this.rddiv >> 8;
      case 0x4216:
        return this.rdmpy & 0xff;
      case 0x4217:
        return this.rdmpy >> 8;
      default:
        if (lo >= 0x4218 && lo < 0x4220) return this.ioreg[0x200 + (lo - 0x4200)]!;
        if (lo >= 0x4300 && lo < 0x4380) return this.ioreg[0x200 + (lo - 0x4200)]!;
        return 0;
    }
  }

  ioWrite(lo: number, v: number): void {
    if (lo >= 0x2140 && lo < 0x2180) lo = 0x2140 | (lo & 3);
    let old = 0;
    if (lo >= 0x2100 && lo < 0x2200) {
      old = this.ioreg[lo - 0x2100]!;
      this.ioreg[lo - 0x2100] = v;
    } else if (lo >= 0x4200 && lo < 0x4400) {
      if (lo >= 0x4218 && lo < 0x4220) return; // joypad registers are read-only
      old = this.ioreg[0x200 + (lo - 0x4200)]!;
      this.ioreg[0x200 + (lo - 0x4200)] = v;
    }
    if (lo >= 0x2140 && lo < 0x2144) {
      this.apu.write(lo & 3, v, this.cyc);
      return;
    }
    if ((lo >= 0x210d && lo <= 0x2114) || (lo >= 0x211b && lo <= 0x2120)) {
      this.ppuWrite(lo, v);
      return;
    }
    switch (lo) {
      case 0x2100:
        if ((v & 15) > this.ppu[PpuReg.MAX_BRIGHTNESS]!) this.ppu[PpuReg.MAX_BRIGHTNESS] = v & 15;
        break;
      case 0x2132:
        if (v !== old) {
          if (v & 0x80) this.ppu[PpuReg.FIXED_B] = v & 0x1f;
          if (v & 0x40) this.ppu[PpuReg.FIXED_G] = v & 0x1f;
          if (v & 0x20) this.ppu[PpuReg.FIXED_R] = v & 0x1f;
        }
        break;
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
        // VRAM is only writable in vertical blank or forced blank; the address still steps
        if ((this.ioreg[0]! & 0x80) !== 0 || this.vline >= 225) {
          const a = ((this.vmaddr << 1) | (lo & 1)) & 0xffff;
          const vmain = this.ioreg[0x15]!;
          if ((vmain & 0x60) === 0) this.vram[a] = v;
          else {
            const o = this.objxOffset(a);
            if (o >= 0) this.objx[o + (vmain & 0x40 ? 0 : OBJX_BANK2)] = v;
          }
        }
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
          this.ioreg[0x1f7] = 0;
        }
        this.ioreg[0x1f6] = v & 1;
        break;
      case 0x4200:
        // NMITIMEN: H / V timer IRQ enables (bits 4-5); NMI (bit 7) is never enabled by the game
        if ((v & 0x30) === 0) this.irqLine = false;
        if ((v & 0x30) !== (old & 0x30)) updateIrq(this, (v & 0x30) === 0 || (old & 0x30) === 0);
        break;
      case 0x4207:
      case 0x4208:
        if (v !== old) updateIrq(this, false);
        break;
      case 0x4209:
      case 0x420a:
        if (v !== old) updateIrq(this, true);
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
        if (v !== 0) this.dma(v);
        break;
      case 0x420c:
        this.hdma = v & ~this.hdmaEnded;
        break;
      case 0x420d:
        this.fast = v & 1 ? 6 : 8;
        break;
    }
  }

  /** Scroll ($210D-$2114) and Mode 7 ($211B-$2120) registers: two writes through shared latches. */
  private ppuWrite(lo: number, v: number): void {
    const p = this.ppu;
    if (lo <= 0x2114) {
      const bg = (lo - 0x210d) >> 1;
      const latch = p[PpuReg.OFS_LATCH]!;
      if (((lo - 0x210d) & 1) === 0) {
        const h = p[PpuReg.HOFS + bg]!;
        p[PpuReg.HOFS + bg] = (v << 8) | (latch & ~7) | ((h >> 8) & 7);
      } else {
        p[PpuReg.VOFS + bg] = (v << 8) | latch;
      }
      p[PpuReg.OFS_LATCH] = v;
      if (lo <= 0x210e) p[PpuReg.M7_LATCH] = v; // BG1 scroll doubles as the Mode 7 scroll
      return;
    }
    if (lo === 0x211b) p[PpuReg.M7A] = p[PpuReg.M7_LATCH]! | (v << 8);
    else if (lo === 0x211c) p[PpuReg.M7B] = p[PpuReg.M7_LATCH]! | (v << 8);
    if (lo >= 0x211b) p[PpuReg.M7_LATCH] = v;
  }

  /** Offset in objx of a VRAM byte address of the sprite tables (OBSEL), or -1 outside them. */
  objxOffset(a: number): number {
    const obsel = this.ioreg[0x01]!;
    const base = (obsel & 3) << 14;
    const rel = (a - base) & 0xffff;
    if (rel < 0x2000) return rel;
    const rel2 = (rel - (((obsel >> 3) & 3) << 13)) & 0xffff;
    return rel2 >= 0x2000 && rel2 < 0x4000 ? rel2 : -1;
  }

  /** General DMA on the channels set in `mask` (A-bus <-> B-bus $21xx): 8 clocks a byte. */
  private dma(mask: number): void {
    this.tick(DMA_SYNC);
    for (let ch = 0; ch < 8; ch++) {
      if (!(mask & (1 << ch))) continue;
      const r = 0x300 + 16 * ch; // ioreg offset of $43x0
      const ctrl = this.ioreg[r]!;
      const bReg = 0x2100 | this.ioreg[r + 1]!;
      let src = this.ioreg[r + 2]! | (this.ioreg[r + 3]! << 8);
      const bank = this.ioreg[r + 4]!;
      let count = this.ioreg[r + 5]! | (this.ioreg[r + 6]! << 8);
      if (count === 0) count = 0x10000;
      const pattern = MODE_OFFSETS[ctrl & 7]!;
      const fixed = (ctrl & 0x08) !== 0;
      const step = ctrl & 0x10 ? -1 : 1;
      const toA = (ctrl & 0x80) !== 0;
      const wholeOam = bReg === 0x2104 && !toA && this.oamaddr === 0;
      this.tick(8);
      for (let k = 0; k < count; k++) {
        const b = bReg + pattern[k % pattern.length]!;
        const a = (bank << 16) | src;
        if (toA) this.poke8(a, this.ioRead(b));
        else this.ioWrite(b, this.peek8(a));
        if (!fixed) src = (src + step) & 0xffff;
        this.tick(8);
      }
      this.ioreg[r + 2] = src & 0xff;
      this.ioreg[r + 3] = src >> 8;
      this.ioreg[r + 5] = 0;
      this.ioreg[r + 6] = 0;
      if (wholeOam) {
        this.oamx.set(this.oamxNext);
        this.oamWideX.set(this.oamWideXNext);
        this.oamExt.set(this.oamExtNext);
        this.oamExtCount = this.oamExtCountNext;
      }
    }
  }

  // ---- snapshots ---------------------------------------------------------------------------

  private regWords(): number[] {
    return [this.a, this.x, this.y, this.s, this.d, this.db, this.pb, this.p | (this.e ? 0x100 : 0), this.pc,
      this.wmaddr, this.vmaddr, this.cgaddr, this.oamaddr, this.mulA, this.rdmpy, this.rddiv, this.divDividend,
      this.cyc, this.vline, this.hMax, this.event, this.hNext, this.refresh, this.field, this.irqAt,
      this.irqLine ? 1 : 0, this.iChange, this.waiting ? 1 : 0, this.fast, this.nmiFlag, this.hdma,
      this.hdmaEnded, this.frames, this.overclock, this.wide, this.tall,
      this.hudTop, this.hudLift, this.hudBottom, this.hudDrop, this.rulesWord, this.oamExtCount, this.oamExtCountNext,
      this.hudxRows, this.hudxRow];
  }

  /** Size of a snapshot in bytes. */
  get stateSize(): number {
    return STATE_SIZE;
  }

  /** Snapshot the whole machine: a new copy, or into `into` (stateSize bytes, no allocation). */
  save(into?: Uint8Array): Uint8Array {
    const dv = new DataView(this.state.buffer, this.state.byteOffset + REGS, 4 * REG_WORDS);
    this.regWords().forEach((w, k) => dv.setInt32(4 * k, w, true));
    this.apu.save();
    if (!into) return this.state.slice();
    into.set(this.state);
    return into;
  }

  load(snap: Uint8Array): void {
    this.state.set(snap);
    this.apu.load();
    const dv = new DataView(this.state.buffer, this.state.byteOffset + REGS, 4 * REG_WORDS);
    const w = (k: number) => dv.getInt32(4 * k, true);
    this.a = w(0);
    this.x = w(1);
    this.y = w(2);
    this.s = w(3);
    this.d = w(4);
    this.db = w(5);
    this.pb = w(6);
    this.irqLine = false; // setP must not stop: brk is reset by the frame loop
    this.setP(w(7) & 0xff);
    this.e = (w(7) & 0x100) !== 0;
    this.pc = w(8);
    this.wmaddr = w(9);
    this.vmaddr = w(10);
    this.cgaddr = w(11);
    this.oamaddr = w(12);
    this.mulA = w(13);
    this.rdmpy = w(14);
    this.rddiv = w(15);
    this.divDividend = w(16);
    this.cyc = w(17);
    this.vline = w(18);
    this.hMax = w(19);
    this.event = w(20);
    this.hNext = w(21);
    this.refresh = w(22);
    this.field = w(23);
    this.irqAt = w(24);
    this.irqLine = w(25) !== 0;
    this.iChange = w(26) as IChange;
    this.waiting = w(27) !== 0;
    this.fast = w(28);
    this.nmiFlag = w(29);
    this.hdma = w(30);
    this.hdmaEnded = w(31);
    this.frames = w(32);
    this.overclock = w(33);
    this.wide = w(34);
    this.tall = w(35);
    this.hudTop = w(36);
    this.hudLift = w(37);
    this.hudBottom = w(38);
    this.hudDrop = w(39);
    this.rulesWord = w(40);
    this.oamExtCount = w(41);
    this.oamExtCountNext = w(42);
    this.hudxRows = w(43);
    this.hudxRow = w(44);
    this.brk = this.irqAt;
    this.frameDone = false;
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
