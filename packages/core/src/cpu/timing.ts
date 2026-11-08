/**
 * Scanline timing, the model of the oracle (snes9x): the CPU counts master clocks within the
 * current scanline (`cyc`, 0..1363) and the line number (`vline`, 0..261, NTSC, no interlace).
 * Fixed events in each line steal time or act: HDMA at 1106, the line end at 1364, HDMA
 * setup at 20 on line 0, DRAM refresh (40 clocks) at 534 / 538, the line's picture at 512
 * (lines 1-224 are the visible lines 0-223). The H/V timer IRQ fires at a
 * position in clocks (`irqAt`, relative to the current line like `cyc`). The frame ends when
 * line 225 (vertical blank) begins; the auto-joypad read is on line 227.
 */
import type { Machine } from './machine.ts';

export const H_MAX = 1364;
export const V_MAX = 262;
export const SCREEN_HEIGHT = 224;
const VBLANK_LINE = SCREEN_HEIGHT + 1;
const HBLANK_START = 1096;
const HBLANK_END = 4;
const HDMA_START = 1106;
const HDMA_INIT = 20;
const RENDER = 512;
const REFRESH = 538;
const REFRESH_CYCLES = 40;
const IRQ_TRIGGER = 14;
export const DMA_SYNC = 18;
/** no timer IRQ scheduled */
export const NEVER = 0x0fffffff;
/** `brk` value that stops the translated code at the next instruction boundary */
export const STOP = -0x40000000;

/** The fixed events of a line, in order (snes9x WhichEvent). */
export const Ev = {
  HblankStart: 1,
  HdmaStart: 2,
  LineEnd: 3,
  HdmaInit: 4,
  Render: 5,
  Refresh: 6,
} as const;

/** Bytes per HDMA unit and their B-bus register offsets, by transfer mode. */
export const MODE_OFFSETS: readonly (readonly number[])[] = [[0], [0, 1], [0, 0], [0, 0, 1, 1], [0, 1, 2, 3], [0, 1, 0, 1], [0, 0], [0, 0, 1, 1]];

/** Move to the next fixed event of the line. */
function reschedule(m: Machine): void {
  switch (m.event) {
    case Ev.HblankStart:
      m.event = Ev.HdmaStart;
      m.hNext = HDMA_START;
      break;
    case Ev.HdmaStart:
      m.event = Ev.LineEnd;
      m.hNext = m.hMax;
      break;
    case Ev.LineEnd:
      m.event = Ev.HdmaInit;
      m.hNext = HDMA_INIT;
      break;
    case Ev.HdmaInit:
      m.event = Ev.Render;
      m.hNext = RENDER;
      break;
    case Ev.Render:
      m.event = Ev.Refresh;
      m.hNext = m.refresh;
      break;
    default:
      m.event = Ev.HblankStart;
      m.hNext = HBLANK_START;
  }
}

/** The event due at `hNext` (called while cyc >= hNext). */
export function hEvent(m: Machine): void {
  switch (m.event) {
    case Ev.HdmaStart:
      reschedule(m);
      if (m.hdma !== 0 && m.vline <= SCREEN_HEIGHT) m.hdma = doHdma(m, m.hdma);
      return;
    case Ev.LineEnd:
      lineEnd(m);
      reschedule(m);
      return;
    case Ev.HdmaInit:
      reschedule(m);
      if (m.vline === 0) startHdma(m);
      return;
    case Ev.Refresh:
      m.cyc += REFRESH_CYCLES;
      reschedule(m);
      return;
    case Ev.Render:
      reschedule(m);
      if (m.onLine !== null && m.vline >= 1 && m.vline <= SCREEN_HEIGHT) m.onLine(m.vline - 1);
      return;
    default:
      reschedule(m);
  }
}

function lineEnd(m: Machine): void {
  m.cyc -= m.hMax;
  if (m.irqAt !== NEVER) m.irqAt -= m.hMax;
  if (m.brk !== STOP) m.brk = m.irqAt;
  m.vline++;
  if (m.vline >= V_MAX) {
    m.vline = 0;
    m.field ^= 1;
    m.nmiFlag = 0;
  }
  // without interlace, line 240 of every other frame is one dot short
  m.hMax = m.vline === 240 && m.field === 1 ? H_MAX - 4 : H_MAX;
  if (m.vline !== 240 || m.field === 0) m.refresh = m.refresh === REFRESH - 4 ? REFRESH : REFRESH - 4;
  if (m.vline === VBLANK_LINE) {
    m.frameDone = true;
    m.brk = STOP;
    m.hdma = 0;
    m.nmiFlag = 0x80;
    m.ppu[15] = m.ioreg[0]! & 15; // PpuReg.MAX_BRIGHTNESS: the frame starts at the brightness it has
  }
  if (m.vline === SCREEN_HEIGHT + 3 && (m.ioreg[0x200]! & 1) !== 0) m.autoJoypad();
}

/** HVBJOY ($4212): vertical blank, horizontal blank, auto-joypad busy. */
export function hvbjoy(m: Machine): number {
  let b = 0;
  if (m.vline >= VBLANK_LINE && m.vline < VBLANK_LINE + 3) b = 1;
  if (m.cyc < HBLANK_END || m.cyc >= HBLANK_START) b |= 0x40;
  if (m.vline >= VBLANK_LINE) b |= 0x80;
  return b;
}

// ---- H/V timer IRQ ---------------------------------------------------------------------------

function cyclesUntilNext(m: Machine, hc: number, vc: number): number {
  let total = 0;
  const vpos = m.vline;
  if (vc - vpos > 0) {
    total += (vc - vpos) * H_MAX;
    if (vpos <= 240 && vc > 240 && m.field === 1) total -= 4;
  } else {
    if (vc === vpos && hc > m.cyc) return hc;
    total += (V_MAX - vpos) * H_MAX;
    if (vpos <= 240 && m.field === 1) total -= 4;
    total += vc * H_MAX;
    if (vc > 240 && m.field === 0) total -= 4;
  }
  return total + hc;
}

/** Recompute `irqAt` from NMITIMEN ($4200 bits 4-5) and HTIME / VTIME. */
export function updateIrq(m: Machine, initial: boolean): void {
  const io = m.ioreg;
  const hEnabled = (io[0x200]! & 0x10) !== 0;
  const vEnabled = (io[0x200]! & 0x20) !== 0;
  const hBeam = io[0x207]! | ((io[0x208]! & 1) << 8);
  const vBeam = io[0x209]! | ((io[0x20a]! & 1) << 8);
  let hPos = hBeam * 4 + IRQ_TRIGGER;
  if (hBeam === 0) hPos -= 4;
  if (hBeam > 322) hPos += 2;
  if (hBeam > 326) hPos += 2;
  let at: number;
  if ((vEnabled && vBeam >= V_MAX) || (!hEnabled && !vEnabled)) {
    at = NEVER;
  } else if (hEnabled && !vEnabled) {
    let vNext = m.vline;
    at = hPos;
    if (m.cyc > at - IRQ_TRIGGER) {
      at += m.hMax;
      vNext++;
    }
    if (vNext === 240 && m.field === 1) {
      if (hBeam <= 322) at -= 2;
      if (hBeam <= 326) at -= 2;
    }
  } else if (!hEnabled) {
    at = m.vline === vBeam && initial ? m.cyc + IRQ_TRIGGER - 4 : cyclesUntilNext(m, IRQ_TRIGGER - 4, vBeam);
  } else {
    at = cyclesUntilNext(m, hPos, vBeam);
    let field = m.field;
    if (vBeam < m.vline || (vBeam === m.vline && at > m.hMax)) field ^= 1;
    if (vBeam === 240 && field === 1) {
      if (hBeam <= 322) at -= 2;
      if (hBeam <= 326) at -= 2;
    }
  }
  m.irqAt = at;
  if (m.brk !== STOP) m.brk = at;
}

// ---- HDMA ------------------------------------------------------------------------------------
// Channel state in the DMA registers, as on hardware: $43x8/9 table address, $43x5/6 indirect
// address, $43xA line counter (0-128); repeat / transfer flags in ioreg[0x1e0 + ch].

function hdmaReg(ch: number, k: number): number {
  return 0x300 + 16 * ch + k;
}

function rd16(m: Machine, ch: number, k: number): number {
  return m.ioreg[hdmaReg(ch, k)]! | (m.ioreg[hdmaReg(ch, k + 1)]! << 8);
}

function wr16(m: Machine, ch: number, k: number, v: number): void {
  m.ioreg[hdmaReg(ch, k)] = v & 0xff;
  m.ioreg[hdmaReg(ch, k + 1)] = (v >> 8) & 0xff;
}

const REPEAT = 1;
const TRANSFER = 2;

function readLineCount(m: Machine, ch: number): boolean {
  const io = m.ioreg;
  const bank = io[hdmaReg(ch, 4)]! << 16;
  const indirect = (io[hdmaReg(ch, 0)]! & 0x40) !== 0;
  let addr = rd16(m, ch, 8);
  const line = m.peek8(bank | addr);
  m.cyc += 8;
  if (line === 0) {
    io[0x1e0 + ch] = 0;
    io[hdmaReg(ch, 10)] = 128;
    if (indirect) {
      if ((m.hdma & (0xfe << ch)) !== 0) {
        addr = (addr + 1) & 0xffff;
        m.cyc += 16;
      } else {
        m.cyc += 8;
      }
      wr16(m, ch, 5, m.peek8(bank | addr) | (m.peek8(bank | ((addr + 1) & 0xffff)) << 8));
      addr = (addr + 1) & 0xffff;
    }
    wr16(m, ch, 8, (addr + 1) & 0xffff);
    return false;
  }
  let repeat: boolean;
  if (line === 0x80) {
    repeat = true;
    io[hdmaReg(ch, 10)] = 128;
  } else {
    repeat = (line & 0x80) === 0;
    io[hdmaReg(ch, 10)] = line & 0x7f;
  }
  addr = (addr + 1) & 0xffff;
  if (indirect) {
    m.cyc += 16;
    wr16(m, ch, 5, m.peek8(bank | addr) | (m.peek8(bank | ((addr + 1) & 0xffff)) << 8));
    addr = (addr + 2) & 0xffff;
  }
  wr16(m, ch, 8, addr);
  io[0x1e0 + ch] = (repeat ? REPEAT : 0) | TRANSFER;
  return true;
}

function startHdma(m: Machine): void {
  m.hdma = m.ioreg[0x20c]!;
  m.hdmaEnded = 0;
  if (m.hdma !== 0) m.cyc += DMA_SYNC;
  for (let ch = 0; ch < 8; ch++) {
    if ((m.hdma & (1 << ch)) === 0) {
      m.ioreg[0x1e0 + ch]! &= ~TRANSFER;
      continue;
    }
    wr16(m, ch, 8, rd16(m, ch, 2));
    if (!readLineCount(m, ch)) {
      m.hdma &= ~(1 << ch);
      m.hdmaEnded |= 1 << ch;
    }
  }
}

function doHdma(m: Machine, active: number): number {
  const io = m.ioreg;
  m.cyc += DMA_SYNC;
  for (let ch = 0; ch < 8; ch++) {
    if ((active & (1 << ch)) === 0 || (io[0x1e0 + ch]! & TRANSFER) === 0) continue;
    const ctrl = io[hdmaReg(ch, 0)]!;
    const indirect = (ctrl & 0x40) !== 0;
    const bank = io[hdmaReg(ch, indirect ? 7 : 4)]! << 16;
    const addr = indirect ? rd16(m, ch, 5) : rd16(m, ch, 8);
    const b = 0x2100 | io[hdmaReg(ch, 1)]!;
    const offsets = MODE_OFFSETS[ctrl & 7]!;
    for (let k = 0; k < offsets.length; k++) {
      m.ioWrite(b + offsets[k]!, m.peek8(bank | ((addr + k) & 0xffff)));
      m.cyc += 8;
    }
  }
  for (let ch = 0; ch < 8; ch++) {
    const mask = 1 << ch;
    if ((active & mask) === 0) continue;
    const flags = io[0x1e0 + ch]!;
    if ((flags & TRANSFER) !== 0) {
      const n = MODE_OFFSETS[io[hdmaReg(ch, 0)]! & 7]!.length;
      const k = (io[hdmaReg(ch, 0)]! & 0x40) !== 0 ? 5 : 8;
      wr16(m, ch, k, rd16(m, ch, k) + n);
    }
    io[0x1e0 + ch] = (flags & REPEAT) | ((flags & REPEAT) === 0 ? TRANSFER : 0);
    const lines = (io[hdmaReg(ch, 10)]! - 1) & 0xff;
    io[hdmaReg(ch, 10)] = lines;
    if (lines === 0) {
      if (!readLineCount(m, ch)) {
        active &= ~mask;
        m.hdmaEnded |= mask;
        io[0x1e0 + ch]! &= ~TRANSFER;
      }
    } else {
      m.cyc += 8;
    }
  }
  return active;
}
