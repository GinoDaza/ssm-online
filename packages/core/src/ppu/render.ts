/**
 * The picture: renders each visible line when the beam reaches it (Machine.onLine), from the
 * PPU state the game left in VRAM, CGRAM, OAM and the registers at that moment, so HDMA and
 * mid-frame register writes show where they would on hardware.
 *
 * What the game uses, and so what is drawn: BG mode 1 (BG1 / BG2 4bpp, BG3 2bpp, 8x8 or 16x16
 * tiles, BG3 priority), sprites (all sizes, 32 per line, 34 tiles per line), windows 1 / 2 on
 * the layers and the color window, color math with the fixed color (add / subtract, half),
 * brightness and forced blank. Not drawn (the game never uses them): other BG modes (only
 * sprites and the backdrop show), mosaic, the subscreen as a color-math source, hi-res,
 * interlace and OAM priority rotation.
 *
 * Pixels are RGB565 and the arithmetic is the oracle's (snes9x: brightness before color math,
 * its add / subtract / half), so a frame can be compared with the emulator's exactly.
 *
 * A wider renderer (`width` > 256) puts the SNES picture in the middle. While the machine says
 * so (Machine.wide, a mode extension) it fills the sides too: BG1 / BG2 go on through their
 * maps, BG3 (the HUD) stays in the middle 256, sprites take their real x (Machine.oamWideX),
 * windows are taken at the nearest middle column, and the 32-sprite / 34-tile line limits are
 * lifted (more of the line is on screen). Otherwise the sides are black.
 *
 * And taller: while Machine.tall is set, the forced-blank lines above the first drawn line are
 * drawn with that line's state, and the lines from Machine.tall down with the state of the line
 * before it (after it the game is already uploading the next frame). The HUD (BG3) bands at
 * the top and bottom move to the new edges (Machine.hudTop / hudLift / hudBottom / hudDrop).
 */
import { type Machine, PpuReg } from '../cpu/machine.ts';

export const WIDTH = 256;
export const HEIGHT = 224;

/** A 5-bit channel at brightness 0-15: round(c * b / 15), the oracle's table. */
const XB: Uint8Array[] = Array.from({ length: 16 }, (_, b) => Uint8Array.from({ length: 32 }, (_, c) => Math.trunc((2 * c * b + 15) / 30)));

function rgb565(r: number, g: number, b: number): number {
  return (r << 11) | (g << 6) | ((g & 0x10) << 1) | b;
}

// ---- color math (snes9x gfx.h, RGB565) --------------------------------------------------------

function add(c1: number, c2: number): number {
  const rb = (c1 & 0xf81f) + (c2 & 0xf81f);
  const g = (c1 & 0x07c0) + (c2 & 0x07c0);
  const sat = (((g & 0x0800) | (rb & 0x10020)) >> 5) * 0x1f;
  const r = ((rb & 0xf81f) | (g & 0x07c0) | sat) & 0xffff;
  return r | ((r & 0x0400) >> 5);
}

function addHalf(c1: number, c2: number): number {
  return ((((c1 & 0xf7de) + (c2 & 0xf7de)) >> 1) + (c1 & c2 & 0x0821)) & 0xffff;
}

function sub(c1: number, c2: number): number {
  const rb = ((c1 & 0xf81f) | 0x10020) - (c2 & 0xf81f);
  const g = ((c1 & 0x07e0) | 0x0800) - (c2 & 0x07e0);
  const sat = (((g & 0x0800) | (rb & 0x10020)) >> 5) * 0x1f;
  const r = ((rb & 0xf81f) | (g & 0x07e0)) & sat & 0xffff;
  return r | ((r & 0x0400) >> 5);
}

/** snes9x GFX.ZERO: keep each channel's low bits where its top bit survived, else 0. */
function zero(x: number): number {
  const r = (x >> 11) & 31;
  const g = (x >> 5) & 63;
  const b = x & 31;
  return ((r & 0x10 ? r & 0x0f : 0) << 11) | ((g & 0x20 ? g & 0x1f : 0) << 5) | (b & 0x10 ? b & 0x0f : 0);
}

function subHalf(c1: number, c2: number): number {
  return zero((((c1 | 0x10820) - (c2 & 0xf7de)) >> 1) & 0xffff);
}

/** Saturating add capped at the brightness's full intensity (snes9x COLOR_ADD_BRIGHTNESS). */
function addCapped(c1: number, c2: number, cap: number): number {
  const ch = (v: number) => (v > cap ? cap : v);
  const g = ch(((c1 >> 6) & 31) + ((c2 >> 6) & 31));
  return (ch((c1 >> 11) + (c2 >> 11)) << 11) | (g << 6) | ((g & 0x10) << 1) | ch((c1 & 31) + (c2 & 31));
}

/** Color-math paths of the oracle (its renderer index): */
const Op = { NONE: 0, ADD: 1, ADD_HALF: 2, SUB: 4, SUB_HALF: 5, ADD_CAPPED: 7 } as const;

// ---- layers -------------------------------------------------------------------------------------

/** Layer ids: BG1-BG4 0-3, sprites 4, backdrop 5 (the bit numbers of TM / CGADSUB). */
const OBJ = 4;
const BACKDROP = 5;

/** Sprite sizes by OBSEL bits 5-7: small w, h, large w, h. */
const OBJ_SIZES = [
  [8, 8, 16, 16],
  [8, 8, 32, 32],
  [8, 8, 64, 64],
  [16, 16, 32, 32],
  [16, 16, 64, 64],
  [32, 32, 64, 64],
  [16, 32, 32, 64],
  [16, 32, 32, 32],
] as const;

export class Renderer {
  /** picture width in pixels (256: the SNES) */
  readonly width: number;
  /** the frame, RGB565 (the oracle's pixel format), row by row */
  readonly pixels: Uint16Array;
  /** CGRAM colors, then the second sprite bank's palettes (Machine.cgramx) at 256-383 */
  private readonly pal = new Uint16Array(384);
  /** the raw colors pal was made from, and the brightness (-1: none yet) */
  private readonly palRaw = new Int32Array(384).fill(-1);
  private palBrightness = -1;
  /** the registers and columns the window modes were last made for */
  private readonly windowKey = new Int32Array(12).fill(-1);
  /** this line: winning layer, its color index (CGRAM), its depth */
  private readonly layer: Uint8Array;
  private readonly color: Uint16Array;
  private readonly depth: Uint8Array;
  /** layers not drawn (TM bits: BG1-BG3 1 / 2 / 4, sprites 10), for diagnostics */
  hide = 0;
  /** this line's sprite pixels: CGRAM index (0 = none) and priority */
  private readonly objColor: Uint16Array;
  private readonly objPrio: Uint8Array;
  /** drawing mode of each layer at each x of this line (see windows()) */
  private readonly modes: Uint8Array;
  private readonly spriteList = new Int16Array(256);
  /** this line: the columns drawn [x0, x1) and the SNES x of column 0 (negative: a side) */
  private x0 = 0;
  private x1 = WIDTH;
  private origin = 0;

  private readonly m: Machine;
  /** a tall frame (Machine.tall): its picture has started */
  private drawn = false;

  constructor(m: Machine, width = WIDTH) {
    this.m = m;
    this.width = width;
    this.pixels = new Uint16Array(width * HEIGHT);
    this.layer = new Uint8Array(width);
    this.color = new Uint16Array(width);
    this.depth = new Uint8Array(width);
    this.objColor = new Uint16Array(width);
    this.objPrio = new Uint8Array(width);
    this.modes = new Uint8Array(6 * width);
  }

  /** Draw every frame from now on (one line at a time, as the beam goes). */
  attach(): void {
    this.m.onLine = (y) => this.line(y);
  }

  /** Stop drawing (e.g. while a rollback re-simulates frames nobody will see). */
  detach(): void {
    this.m.onLine = null;
  }

  /** The frame as RGBA bytes (for a canvas). */
  toRgba(out: Uint8Array | Uint8ClampedArray): void {
    const px = this.pixels;
    for (let i = 0, o = 0; i < px.length; i++, o += 4) {
      const p = px[i]!;
      const r = p >> 11;
      const g = (p >> 5) & 63;
      const b = p & 31;
      out[o] = (r << 3) | (r >> 2);
      out[o + 1] = (g << 2) | (g >> 4);
      out[o + 2] = (b << 3) | (b >> 2);
      out[o + 3] = 255;
    }
  }

  line(y: number): void {
    const end = this.m.tall;
    if (end === 0) return this.draw(y);
    if (y === 0) this.drawn = false;
    if (this.drawn && y >= end && y < HEIGHT) return; // drawn with line end - 1
    this.draw(y);
    if (this.m.ioreg[0x00]! & 0x80) return;
    if (!this.drawn) for (let k = 0; k < y; k++) this.draw(k);
    this.drawn = true;
    if (y === end - 1) for (let k = end; k < HEIGHT; k++) this.draw(k);
  }

  /** Draw screen line `y` from the PPU state as it is now. */
  private draw(y: number): void {
    const m = this.m;
    const io = m.ioreg;
    const W = this.width;
    const row = y * W;
    const side = (W - WIDTH) >> 1;
    const wide = Math.min(m.wide, side);
    this.origin = -side;
    this.x0 = side - wide;
    this.x1 = side + WIDTH + wide;
    this.pixels.fill(0, row, row + W);
    const inidisp = io[0x00]!;
    if (inidisp & 0x80) return;
    const xb = XB[inidisp & 15]!;
    this.palette(inidisp & 15, xb);
    this.windows();
    this.layer.fill(BACKDROP);
    this.color.fill(0);
    this.depth.fill(0);

    const tm = io[0x2c]! & ~this.hide;
    const bgmode = io[0x05]!;
    if (tm & 0x10) {
      this.sprites(y);
      for (let x = this.x0; x < this.x1; x++) {
        const c = this.objColor[x]!;
        if (c !== 0) this.put(x, OBJ, c, 4 + 4 * this.objPrio[x]!);
      }
    }
    if ((bgmode & 7) === 1) {
      if (tm & 1) this.background(y, 0, 4, 15, 11);
      if (tm & 2) this.background(y, 1, 4, 14, 10);
      if (tm & 4) this.background(y, 2, 2, bgmode & 8 ? 17 : 7, 3, true);
    }
    this.compose(row, xb);
  }

  /** CGRAM (and the bank's palettes) -> RGB565 at this brightness: only the colors that changed. */
  private palette(brightness: number, xb: Uint8Array): void {
    const m = this.m;
    const raw = this.palRaw;
    const all = brightness !== this.palBrightness;
    this.palBrightness = brightness;
    for (let i = 0; i < 384; i++) {
      const src = i < 256 ? m.cgram : m.cgramx;
      const j = i < 256 ? 2 * i : 2 * (i - 256);
      const c = src[j]! | (src[j + 1]! << 8);
      if (!all && raw[i] === c) continue;
      raw[i] = c;
      this.pal[i] = rgb565(xb[c & 31]!, xb[(c >> 5) & 31]!, xb[(c >> 10) & 31]!);
    }
  }

  /**
   * Drawing mode of every layer at every x of this line (modes[layer * 256 + x]): bit 0 = its
   * color shows (not clipped to black), bit 1 = color math allowed; 0 = the layer is not drawn
   * there. The color window decides clipping and math; a layer's own window can hide it (TMW).
   */
  private windows(): void {
    const io = this.m.ioreg;
    const key = this.windowKey;
    const now = [io[0x23]!, io[0x24]!, io[0x25]!, io[0x26]!, io[0x27]!, io[0x28]!, io[0x29]!, io[0x2a]!, io[0x2b]!, (io[0x2e]! << 8) | io[0x30]!, this.x0, this.x1];
    let same = true;
    for (let k = 0; k < 12; k++) if (key[k] !== now[k]) {
      same = false;
      key[k] = now[k]!;
    }
    if (same) return;
    const w1l = io[0x26]!;
    const w1r = io[0x27]!;
    const w2l = io[0x28]!;
    const w2r = io[0x29]!;
    const tmw = io[0x2e]!;
    const cgwsel = io[0x30]!;
    const modes = this.modes;
    const W = this.width;
    for (let j = 0; j < 6; j++) {
      const s = (j < 4 ? io[0x23 + (j >> 1)]! >> (4 * (j & 1)) : io[0x25]! >> (4 * (j - 4))) & 15;
      const l = (j < 4 ? io[0x2a]! >> (2 * j) : io[0x2b]! >> (2 * (j - 4))) & 3;
      const e1 = (s & 2) !== 0;
      const e2 = (s & 8) !== 0;
      for (let x = this.x0; x < this.x1; x++) {
        const gx = Math.min(255, Math.max(0, x + this.origin)); // the nearest SNES column
        const a = (w1l <= w1r && gx >= w1l && gx <= w1r) !== ((s & 1) !== 0);
        const b = (w2l <= w2r && gx >= w2l && gx <= w2r) !== ((s & 4) !== 0);
        const w = !e1 ? e2 && b : !e2 ? a : l === 0 ? a || b : l === 1 ? a && b : l === 2 ? a !== b : a === b;
        modes[j * W + x] = w ? 1 : 0; // window flags first, modes below
      }
    }
    const color = cgwsel >> 6;
    const math = (cgwsel >> 4) & 3;
    for (let x = this.x0; x < this.x1; x++) {
      const cw = modes[BACKDROP * W + x]!;
      const clip = color === 0 ? 0 : color === 1 ? cw ^ 1 : color === 2 ? cw : 1;
      const prevent = math === 0 ? 0 : math === 1 ? cw ^ 1 : math === 2 ? cw : 1;
      const base = (clip ? 0 : 1) | (prevent ? 0 : 2);
      for (let j = 0; j < BACKDROP; j++) {
        const i = j * W + x;
        modes[i] = tmw & (1 << j) && modes[i] ? 0 : base;
      }
      modes[BACKDROP * W + x] = base;
    }
  }

  private put(x: number, layer: number, color: number, depth: number): void {
    if (depth > this.depth[x]! && this.modes[layer * this.width + x] !== 0) {
      this.layer[x] = layer;
      this.color[x] = color;
      this.depth[x] = depth;
    }
  }

  private background(y: number, n: number, bpp: number, hiDepth: number, loDepth: number, middle = false): void {
    const m = this.m;
    const io = m.ioreg;
    const vram = m.vram;
    const sc = io[0x07 + n]!;
    const mapBase = (sc & 0xfc) << 9;
    const wide = (sc & 1) !== 0;
    const tall = (sc & 2) !== 0;
    const charBase = ((n < 2 ? io[0x0b]! >> (4 * n) : io[0x0c]! >> (4 * (n - 2))) & 15) << 13;
    const big = (io[0x05]! & (0x10 << n)) !== 0;
    const ts = big ? 16 : 8;
    const shift = big ? 4 : 3;
    const hofs = m.ppu[PpuReg.HOFS + n]! & 0x3ff;
    const vofs = m.ppu[PpuReg.VOFS + n]! & 0x3ff;
    let line = y;
    if (middle && m.tall !== 0) {
      if (y < m.hudTop) {
        line = y + m.hudLift;
        if (line >= m.hudTop) return;
      } else if (y >= m.hudBottom) {
        line = y - m.hudDrop;
        if (line < m.hudBottom) return;
      }
    }
    const Y = (line + vofs + 1) & 0x3ff;
    const ty = (Y >> shift) & 63;
    const tileBytes = 8 * bpp;
    const from = middle ? -this.origin : this.x0;
    const to = middle ? -this.origin + WIDTH : this.x1;
    const rowY = Y & (ts - 1);
    const W = this.width;
    const modes = this.modes;
    const base = n * W;
    // one 8-pixel tile row at a time: its map entry, its 2 or 4 bitplanes
    for (let x = from; x < to; ) {
      const X = (x + this.origin + hofs) & 0x3ff;
      const tx = (X >> shift) & 63;
      let screen = 0;
      if (wide && tx >= 32) screen += 0x400;
      if (tall && ty >= 32) screen += wide ? 0x800 : 0x400;
      const a = (mapBase + 2 * (screen + ((ty & 31) << 5) + (tx & 31))) & 0xffff;
      const e = vram[a]! | (vram[a + 1]! << 8);
      const colIn = X & (ts - 1);
      const hflip = (e & 0x4000) !== 0;
      const rowIn = e & 0x8000 ? ts - 1 - rowY : rowY;
      // the 8-pixel half of a 16-pixel tile this x falls in, and the pixels left in it
      const col = hflip ? ts - 1 - colIn : colIn;
      const left = 8 - (X & 7);
      const tile = ((e & 0x3ff) + (col >> 3) + ((rowIn >> 3) << 4)) & 0x3ff;
      const t = (charBase + tile * tileBytes + 2 * (rowIn & 7)) & 0xffff;
      const p0 = vram[t]!;
      const p1 = vram[t + 1]!;
      const p2 = bpp === 4 ? vram[(t + 16) & 0xffff]! : 0;
      const p3 = bpp === 4 ? vram[(t + 17) & 0xffff]! : 0;
      const pal = (e >> 10) & 7;
      const palBase = bpp === 4 ? pal * 16 : pal * 4;
      const d = e & 0x2000 ? hiDepth : loDepth;
      const end = Math.min(to, x + left);
      for (let k = X & 7; x < end; x++, k++) {
        const bit = hflip ? k : 7 - k;
        const c = ((p0 >> bit) & 1) | (((p1 >> bit) & 1) << 1) | (((p2 >> bit) & 1) << 2) | (((p3 >> bit) & 1) << 3);
        if (c === 0 || d <= this.depth[x]! || modes[base + x] === 0) continue;
        this.layer[x] = n;
        this.color[x] = palBase + c;
        this.depth[x] = d;
      }
    }
  }

  /** This line's sprite pixels, with the oracle's 32-sprite and 34-tile limits. */
  private sprites(y: number): void {
    const m = this.m;
    const oam = m.oam;
    const vram = m.vram;
    const obsel = m.ioreg[0x01]!;
    const size = OBJ_SIZES[obsel >> 5]!;
    const base = (obsel & 3) << 14;
    const nameSelect = ((obsel >> 3) & 3) << 13;
    this.objColor.fill(0);
    const list = this.spriteList;
    const wide = this.x0 < -this.origin || this.x1 > -this.origin + WIDTH;
    const maxCount = wide ? 128 : 32;
    let count = 0;
    let tiles = wide ? 1 << 20 : 34;
    const hposOf = (s: number) => {
      if (wide && m.oamx[s]! & 2) return m.oamWideX[s]!;
      const x = oam[4 * s]! | (((oam[512 + (s >> 2)]! >> (2 * (s & 3))) & 1) << 8);
      return x >= 256 ? x - 512 : x;
    };
    const visibleTiles = (s: number, w: number) => {
      let h = hposOf(s);
      if (h === -256) h = 0;
      return h < 0 ? (w + h + 7) >> 3 : h + w > 255 ? (256 - h + 7) >> 3 : w >> 3;
    };
    const left = this.x0 + this.origin;
    const right = this.x1 + this.origin;
    for (let s = 0; s < 128; s++) {
      const large = (oam[512 + (s >> 2)]! >> (2 * (s & 3) + 1)) & 1;
      const w = size[2 * large]!;
      const h = size[2 * large + 1]!;
      let hp = hposOf(s);
      if (hp === -256 && !wide) hp = 0;
      if (!(hp > left - w && hp <= (wide ? right : 256))) continue;
      const line = (y - oam[4 * s + 1]!) & 0xff;
      if (line >= h || count >= maxCount) continue;
      if (!wide) tiles -= visibleTiles(s, w);
      list[2 * count] = s;
      list[2 * count + 1] = oam[4 * s + 3]! & 0x80 ? line ^ (w - 1) : line;
      count++;
    }
    for (let k = 0; k < count; k++) {
      const s = list[2 * k]!;
      const line = list[2 * k + 1]!;
      const large = (oam[512 + (s >> 2)]! >> (2 * (s & 3) + 1)) & 1;
      const w = size[2 * large]!;
      if (!wide) tiles += visibleTiles(s, w);
      if (tiles <= 0) continue;
      const attr = oam[4 * s + 3]!;
      const bank = m.oamx[s]! & 1 ? m.objx : null; // the second sprite bank (Machine extension)
      const name = oam[4 * s + 2]! | ((attr & 1) << 8);
      const hflip = (attr & 0x40) !== 0;
      const rowTile = (((line << 1) + (name & 0xf0)) & 0xf0) | (name & 0x100);
      let tileX = name & 0x0f;
      const inc = hflip ? -1 : 1;
      if (hflip) tileX = (tileX + (w >> 3) - 1) & 0x0f;
      const pal = (bank ? 256 : 128) + ((attr >> 1) & 7) * 16;
      const prio = (attr >> 4) & 3;
      const hpos = hposOf(s);
      let X = hpos === -256 && !wide ? 256 : hpos;
      let t = tiles;
      const end = wide ? right : 256;
      for (; X <= end && X < hpos + w; tileX = (tileX + inc) & 0x0f, X += 8) {
        if (X < left - 7 || --t < 0 || X === end) continue;
        const tile = rowTile | tileX;
        let p0: number, p1: number, p2: number, p3: number;
        if (bank) {
          const a = (tile << 5) + 2 * (line & 7);
          p0 = bank[a]!;
          p1 = bank[a + 1]!;
          p2 = bank[a + 16]!;
          p3 = bank[a + 17]!;
        } else {
          const a = (base + (tile << 5) + (tile & 0x100 ? nameSelect : 0) + 2 * (line & 7)) & 0xffff;
          p0 = vram[a]!;
          p1 = vram[(a + 1) & 0xffff]!;
          p2 = vram[(a + 16) & 0xffff]!;
          p3 = vram[(a + 17) & 0xffff]!;
        }
        for (let px = 0; px < 8; px++) {
          const gx = X + px;
          if (gx < left || gx >= right) continue;
          const sx = gx - this.origin;
          if (this.objColor[sx] !== 0) continue;
          const bit = hflip ? px : 7 - px;
          const c = ((p0 >> bit) & 1) | (((p1 >> bit) & 1) << 1) | (((p2 >> bit) & 1) << 2) | (((p3 >> bit) & 1) << 3);
          if (c === 0) continue;
          this.objColor[sx] = pal + c;
          this.objPrio[sx] = prio;
        }
      }
    }
  }

  /** Winning pixels -> RGB565, with clipping to black and color math against the fixed color. */
  private compose(row: number, xb: Uint8Array): void {
    const m = this.m;
    const io = m.ioreg;
    const cgwsel = io[0x30]!;
    const cgadsub = io[0x31]!;
    const p = m.ppu;
    const fixed = rgb565(xb[p[PpuReg.FIXED_R]!]!, xb[p[PpuReg.FIXED_G]!]!, xb[p[PpuReg.FIXED_B]!]!);
    let op: number = cgadsub & 0x80 ? Op.SUB : Op.ADD;
    let viaSub = false;
    if (cgadsub & 0x40) {
      op++;
      if (cgwsel & 2) viaSub = true; // half with the subscreen: without one, the oracle adds whole
    }
    const capped = p[PpuReg.MAX_BRIGHTNESS]! !== 15;
    if (capped && op === Op.ADD) op = Op.ADD_CAPPED;
    const cap = xb[31]!;
    for (let x = this.x0; x < this.x1; x++) {
      const layer = this.layer[x]!;
      const md = this.modes[layer * this.width + x]!;
      const clip = (md & 1) === 0;
      const main = clip ? 0 : this.pal[this.color[x]!]!;
      let out = main;
      const math = (cgadsub & (1 << layer)) !== 0 && (md & 2) !== 0 && (layer !== OBJ || (this.color[x]! & 0x7f) >= 64); // sprite palettes 4-7
      if (math) {
        if (viaSub || op === Op.ADD || op === Op.SUB || op === Op.ADD_CAPPED) {
          // whole: plain, or the subscreen-half path with no subscreen pixel
          const o = op === Op.ADD_HALF ? (capped ? Op.ADD_CAPPED : Op.ADD) : op === Op.SUB_HALF ? Op.SUB : op;
          out = o === Op.ADD ? add(main, fixed) : o === Op.SUB ? sub(main, fixed) : addCapped(main, fixed, cap);
        } else if (op === Op.ADD_HALF) {
          out = clip ? add(main, fixed) : addHalf(main, fixed);
        } else {
          out = clip ? sub(main, fixed) : subHalf(main, fixed);
        }
      }
      this.pixels[row + x] = out;
    }
  }
}
