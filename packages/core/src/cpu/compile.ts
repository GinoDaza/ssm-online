/**
 * The translator: 65816 code from the ROM -> JavaScript functions, one per basic block, made the
 * first time the block runs with the M / X widths the CPU has at that moment (so every
 * instruction is decoded with its real widths, observed or not). Blocks are cached by
 * (address, M, X). A block returns the address of the next block.
 *
 * Timing: each instruction first spends its opcode / operand fetches and internal cycles
 * (`c.tick`); its data accesses spend their own through the Machine's bus. After each
 * instruction the block returns early when `c.cyc >= c.brk` (an IRQ is due, the frame ended,
 * or the I flag changed), so interrupts land on the instruction boundary they would on
 * hardware. Cycle counts follow the oracle (snes9x), which follows the WDC datasheet.
 *
 * Determinism: the generated code is integer-only and reads nothing but the Machine.
 */
import { romOffset } from '../rom.ts';
import type { Machine } from './machine.ts';
import { OPCODES, X_WIDTH, operandSize, type Mode } from './opcodes.ts';

export type Block = (c: Machine) => number;

const MAX_BLOCK = 96; // instructions per block before a plain continuation
const RMW = new Set(['ASL', 'LSR', 'ROL', 'ROR', 'INC', 'DEC', 'TSB', 'TRB']);
const ALU: Record<string, string> = { ORA: 'ora', AND: 'and', EOR: 'eor', ADC: 'adc', SBC: 'sbc' };
const BRANCH: Record<string, string> = {
  BPL: '!c.n',
  BMI: 'c.n',
  BVC: '!c.v',
  BVS: 'c.v',
  BCC: '!c.c',
  BCS: 'c.c',
  BNE: '!c.z',
  BEQ: 'c.z',
};
const hex = (v: number) => '0x' + v.toString(16);

export interface Decoded {
  pc: number;
  op: number;
  mn: string;
  mode: Mode;
  /** operand value (little-endian) */
  n: number;
  len: number;
}

export function decodeAt(c: Machine, pc: number, m8: boolean, x8: boolean): Decoded {
  const code = (k: number) => c.rom.fileU8(romOffset((pc & 0xff0000) | ((pc + k) & 0xffff)));
  const op = code(0);
  const { mn, mode } = OPCODES[op]!;
  const size = operandSize(mode, m8, x8);
  let n = 0;
  for (let k = 0; k < size; k++) n |= code(1 + k) << (8 * k);
  return { pc, op, mn, mode, n, len: 1 + size };
}

/**
 * Effective address expression and whether 16-bit accesses wrap in bank 0. `always` is true
 * when an indexed mode spends its extra cycle whatever the page (writes, 16-bit index).
 */
function ea(mode: Mode, n: number, always = true): [string, boolean] {
  switch (mode) {
    case 'dp':
      return [`((c.d + ${hex(n)}) & 0xffff)`, true];
    case 'dpx':
      return [`((c.d + ${hex(n)} + c.x) & 0xffff)`, true];
    case 'dpy':
      return [`((c.d + ${hex(n)} + c.y) & 0xffff)`, true];
    case 'ind':
      return [`((c.db << 16) | c.read16z(c.d + ${hex(n)}))`, false];
    case 'indl':
      return [`c.read24z(c.d + ${hex(n)})`, false];
    case 'indy':
      return [`c.indexed((c.db << 16) | c.read16z(c.d + ${hex(n)}), c.y, ${always})`, false];
    case 'indly':
      return [`((c.read24z(c.d + ${hex(n)}) + c.y) & 0xffffff)`, false];
    case 'indx':
      return [`((c.db << 16) | c.read16z(c.d + ${hex(n)} + c.x))`, false];
    case 'abs':
      return [`((c.db << 16) | ${hex(n)})`, false];
    case 'absx':
      return [`c.indexed((c.db << 16) | ${hex(n)}, c.x, ${always})`, false];
    case 'absy':
      return [`c.indexed((c.db << 16) | ${hex(n)}, c.y, ${always})`, false];
    case 'long':
      return [hex(n), false];
    case 'longx':
      return [`((${hex(n)} + c.x) & 0xffffff)`, false];
    case 'sr':
      return [`((c.s + ${hex(n)}) & 0xffff)`, true];
    case 'sry':
      return [`((((c.db << 16) | c.read16z(c.s + ${hex(n)})) + c.y) & 0xffffff)`, false];
    default:
      throw new Error(`no effective address for mode ${mode}`);
  }
}

/** Internal cycles of an addressing mode (6 master clocks each); DL = +1 when D & $FF != 0. */
const MODE_IO: Partial<Record<Mode, number>> = { dpx: 1, dpy: 1, indx: 1, sr: 1, sry: 2 };
const DL_MODES = new Set<Mode>(['dp', 'dpx', 'dpy', 'ind', 'indl', 'indy', 'indly', 'indx']);
/** Internal cycles of an instruction beyond its addressing mode. */
const OP_IO: Record<string, number> = {
  XBA: 2, PLA: 2, PLX: 2, PLY: 2, PLP: 2, PLB: 2, PLD: 2, RTL: 2, RTI: 2, RTS: 3,
};
for (const mn of ['CLC', 'SEC', 'CLI', 'SEI', 'CLD', 'SED', 'CLV', 'TAX', 'TAY', 'TXA', 'TYA', 'TXY', 'TYX',
  'TSX', 'TXS', 'TCD', 'TDC', 'TCS', 'TSC', 'INX', 'INY', 'DEX', 'DEY', 'NOP', 'XCE', 'REP', 'SEP', 'PHA',
  'PHX', 'PHY', 'PHP', 'PHB', 'PHD', 'PHK', 'BRA', 'BRL', 'JSR', 'JSL', 'WAI', ...RMW]) {
  OP_IO[mn] = 1;
}

/** Clocks an instruction spends before its data accesses: fetches + internal cycles. */
function fetchAndIo(d: Decoded): string {
  const fastBank = (d.pc & 0x408000) !== 0 && (d.pc & 0x800000) !== 0;
  let io = (MODE_IO[d.mode] ?? 0) + (OP_IO[d.mn] ?? 0);
  if (d.mn === 'JMP' && d.mode === 'absindx') io++;
  const parts = [fastBank ? `${d.len} * c.fast` : `${8 * d.len}`];
  if (io) parts.push(`${6 * io}`);
  if (DL_MODES.has(d.mode)) parts.push('(c.d & 0xff ? 6 : 0)');
  return parts.join(' + ');
}

interface Emit {
  code: string;
  /** the block ends after this instruction */
  end: boolean;
  m8: boolean;
  x8: boolean;
}

/** One instruction -> JS statements. */
export function emit(d: Decoded, m8: boolean, x8: boolean): Emit {
  const { mn, mode, n } = d;
  const bank = d.pc & 0xff0000;
  const next = bank | ((d.pc + d.len) & 0xffff);
  const W = X_WIDTH.has(mn) || ['INX', 'INY', 'DEX', 'DEY', 'PHX', 'PHY', 'PLX', 'PLY'].includes(mn) ? (x8 ? 8 : 16) : m8 ? 8 : 16;
  const XW = x8 ? 8 : 16;
  const imm = mode === 'immM' || mode === 'immX';
  const R = () => {
    if (imm) return hex(n);
    const [e, z] = ea(mode, n, !x8);
    return `c.rm(${e}, ${W}, ${z})`;
  };
  const out = (code: string, end = false, mm = m8, xx = x8): Emit => ({ code, end, m8: mm, x8: xx });
  const rel = (v: number, bits: number) => (v << (32 - bits)) >> (32 - bits);

  if (mn in ALU) return out(`c.${ALU[mn]}(${R()}, ${W});`);
  if (mn in BRANCH) {
    const target = bank | ((d.pc + d.len + rel(n, 8)) & 0xffff);
    return out(`if (${BRANCH[mn]}) { c.tick(6); return ${hex(target)}; }`);
  }
  if (RMW.has(mn)) {
    const fn = mn === 'DEC' ? 'dec_' : mn.toLowerCase();
    if (mode === 'imp') {
      return out(W === 8 ? `c.a = (c.a & 0xff00) | c.${fn}(c.a & 0xff, 8);` : `c.a = c.${fn}(c.a, 16);`);
    }
    const [e, z] = ea(mode, n);
    return out(`{ const ea = ${e}; c.wm(ea, c.${fn}(c.rm(ea, ${W}, ${z}), ${W}), ${W}, ${z}); }`);
  }
  switch (mn) {
    case 'LDA':
      return out(`c.setA(${R()}, ${W});`);
    case 'LDX':
      return out(`c.x = c.ld(${R()}, ${W});`);
    case 'LDY':
      return out(`c.y = c.ld(${R()}, ${W});`);
    case 'STA':
    case 'STX':
    case 'STY':
    case 'STZ': {
      const [e, z] = ea(mode, n);
      const v = mn === 'STA' ? `c.getA(${W})` : mn === 'STX' ? 'c.x' : mn === 'STY' ? 'c.y' : '0';
      return out(`c.wm(${e}, ${v}, ${W}, ${z});`);
    }
    case 'CMP':
      return out(`c.cmp(c.a, ${R()}, ${W});`);
    case 'CPX':
      return out(`c.cmp(c.x, ${R()}, ${W});`);
    case 'CPY':
      return out(`c.cmp(c.y, ${R()}, ${W});`);
    case 'BIT':
      return out(`c.bit(${R()}, ${W}, ${imm});`);
    case 'INX':
      return out(`c.x = c.inc(c.x, ${XW});`);
    case 'INY':
      return out(`c.y = c.inc(c.y, ${XW});`);
    case 'DEX':
      return out(`c.x = c.dec_(c.x, ${XW});`);
    case 'DEY':
      return out(`c.y = c.dec_(c.y, ${XW});`);
    case 'TAX':
      return out(`c.x = c.ld(${x8 ? 'c.a & 0xff' : 'c.a'}, ${XW});`);
    case 'TAY':
      return out(`c.y = c.ld(${x8 ? 'c.a & 0xff' : 'c.a'}, ${XW});`);
    case 'TXA':
      return out(`c.setA(c.x, ${m8 ? 8 : 16});`);
    case 'TYA':
      return out(`c.setA(c.y, ${m8 ? 8 : 16});`);
    case 'TXY':
      return out(`c.y = c.ld(c.x, ${XW});`);
    case 'TYX':
      return out(`c.x = c.ld(c.y, ${XW});`);
    case 'TSX':
      return out(`c.x = c.ld(${x8 ? 'c.s & 0xff' : 'c.s'}, ${XW});`);
    case 'TXS':
      return out('c.s = c.x;');
    case 'TCD':
      return out('c.d = c.ld(c.a, 16);');
    case 'TDC':
      return out('c.a = c.ld(c.d, 16);');
    case 'TCS':
      return out('c.s = c.a;');
    case 'TSC':
      return out('c.a = c.ld(c.s, 16);');
    case 'XBA':
      return out('c.a = ((c.a >> 8) | (c.a << 8)) & 0xffff; c.nz(c.a, 8);');
    case 'XCE':
      return out(
        `{ const t = c.c; c.c = c.e; c.e = t; if (c.e) { c.setP(c.p | 0x30); c.s = 0x100 | (c.s & 0xff); } } return ${hex(next)};`,
        true,
      );
    case 'PHA':
      return out(W === 8 ? 'c.push8(c.a & 0xff);' : 'c.push16(c.a);');
    case 'PHX':
      return out(XW === 8 ? 'c.push8(c.x);' : 'c.push16(c.x);');
    case 'PHY':
      return out(XW === 8 ? 'c.push8(c.y);' : 'c.push16(c.y);');
    case 'PHP':
      return out('c.push8(c.p);');
    case 'PHB':
      return out('c.push8(c.db);');
    case 'PHD':
      return out('c.push16(c.d);');
    case 'PHK':
      return out(`c.push8(${hex(bank >>> 16)});`);
    case 'PEA':
      return out(`c.push16(${hex(n)});`);
    case 'PEI':
      return out(`c.push16(c.read16z(c.d + ${hex(n)}));`);
    case 'PER':
      return out(`c.push16(${hex((d.pc + d.len + rel(n, 16)) & 0xffff)});`);
    case 'PLA':
      return out(`c.setA(${W === 8 ? 'c.pull8()' : 'c.pull16()'}, ${W});`);
    case 'PLX':
      return out(`c.x = c.ld(${XW === 8 ? 'c.pull8()' : 'c.pull16()'}, ${XW});`);
    case 'PLY':
      return out(`c.y = c.ld(${XW === 8 ? 'c.pull8()' : 'c.pull16()'}, ${XW});`);
    case 'PLB':
      return out('c.db = c.ld(c.pull8(), 8);');
    case 'PLD':
      return out('c.d = c.ld(c.pull16(), 16);');
    case 'PLP':
      return out(`c.setP(c.pull8()); return ${hex(next)};`, true);
    case 'CLC':
      return out('c.c = false;');
    case 'SEC':
      return out('c.c = true;');
    case 'CLI':
      return out('c.changeI(1);');
    case 'SEI':
      return out('c.changeI(2);');
    case 'CLD':
      return out('c.dec = false;');
    case 'SED':
      return out('c.dec = true;');
    case 'CLV':
      return out('c.v = false;');
    case 'REP':
      return out(`c.rep(${hex(n)});`, false, m8 && !(n & 0x20), x8 && !(n & 0x10));
    case 'SEP':
      return out(`c.sep(${hex(n)});`, false, m8 || (n & 0x20) !== 0, x8 || (n & 0x10) !== 0);
    case 'BRA':
      return out(`return ${hex(bank | ((d.pc + d.len + rel(n, 8)) & 0xffff))};`, true);
    case 'BRL':
      return out(`return ${hex(bank | ((d.pc + d.len + rel(n, 16)) & 0xffff))};`, true);
    case 'JMP':
      if (mode === 'abs') return out(`return ${hex(bank | n)};`, true);
      if (mode === 'absind') return out(`return ${hex(bank)} | c.read16z(${hex(n)});`, true);
      return out(`return ${hex(bank)} | c.read16(${hex(bank)} | ((${hex(n)} + c.x) & 0xffff));`, true);
    case 'JML':
      if (mode === 'long') return out(`return ${hex(n)};`, true);
      return out(`return c.read24z(${hex(n)});`, true);
    case 'JSR': {
      const ret = `c.push16(${hex((d.pc + d.len - 1) & 0xffff)});`;
      if (mode === 'abs') return out(`${ret} return ${hex(bank | n)};`, true);
      return out(`{ const t = c.read16(${hex(bank)} | ((${hex(n)} + c.x) & 0xffff)); ${ret} return ${hex(bank)} | t; }`, true);
    }
    case 'JSL':
      return out(`c.push8(${hex(bank >>> 16)}); c.push16(${hex((d.pc + d.len - 1) & 0xffff)}); return ${hex(n)};`, true);
    case 'RTS':
      return out(`return ${hex(bank)} | ((c.pull16() + 1) & 0xffff);`, true);
    case 'RTL':
      return out('{ const lo = c.pull16(); const b = c.pull8(); return (b << 16) | ((lo + 1) & 0xffff); }', true);
    case 'RTI':
      return out('{ c.setP(c.pull8()); const lo = c.pull16(); const b = c.pull8(); return (b << 16) | lo; }', true);
    case 'MVN':
    case 'MVP': {
      // one byte per execution, as on hardware: an IRQ can come between two bytes
      const fetch = fetchAndIo(d);
      const move = `c.moveByte(${hex(n & 0xff)}, ${hex(n >> 8)}, ${mn === 'MVN' ? 1 : -1})`;
      return out(`for (;;) { c.tick(${fetch}); if (${move}) return ${hex(next)}; if (c.cyc >= c.brk) return ${hex(d.pc)}; }`, true);
    }
    case 'WAI':
      return out(`c.waiting = true; return ${hex(next)};`, true);
    case 'NOP':
    case 'WDM':
      return out('');
    default:
      return out(`throw new Error('${mn} at ${hex(d.pc)}');`, true);
  }
}

export interface BlockSource {
  pc: number;
  m8: boolean;
  x8: boolean;
  instructions: number;
  source: string;
}

/** Translate the block starting at pc with widths m8 / x8 (hooked: call c.hook before each instruction). */
export function translate(c: Machine, pc: number, m8: boolean, x8: boolean, hooked = false): BlockSource {
  const start = pc;
  const lines: string[] = [];
  let k = 0;
  for (;;) {
    const d = decodeAt(c, pc, m8, x8);
    const e = emit(d, m8, x8);
    const fetch = d.mn === 'MVN' || d.mn === 'MVP' ? '' : `c.tick(${fetchAndIo(d)}); `;
    k++;
    pc = (pc & 0xff0000) | ((pc + d.len) & 0xffff);
    const boundary = e.end ? '' : ` if (c.cyc >= c.brk) return ${hex(pc)};`;
    const hook = hooked ? `c.hook(${hex(d.pc)}); ` : '';
    lines.push(`/* ${hex(d.pc)} ${d.mn} */ ${hook}${fetch}${e.code}${boundary}`);
    m8 = e.m8;
    x8 = e.x8;
    if (e.end) break;
    if (k >= MAX_BLOCK) {
      // a width change inside the block is known statically; the dispatcher re-reads P anyway
      lines.push(`return ${hex(pc)};`);
      break;
    }
  }
  return { pc: start, m8, x8, instructions: k, source: lines.join('\n') };
}

export class Translator {
  private readonly blocks = new Map<number, Block>();
  compiled = 0;
  /** diagnostics: compile a call of Machine.hook before every instruction */
  hooked = false;

  get(c: Machine, pc: number): Block {
    const key = pc * 4 + (c.m ? 2 : 0) + (c.xf ? 1 : 0);
    let b = this.blocks.get(key);
    if (b === undefined) {
      if ((pc & 0xffff) < 0x8000 && (pc >>> 16 & 0x40) === 0) {
        throw new Error(`code outside ROM at ${hex(pc)} (WRAM / I/O execution is not translated)`);
      }
      const src = translate(c, pc, c.m, c.xf, this.hooked);
      b = new Function('c', src.source) as Block;
      this.blocks.set(key, b);
      this.compiled++;
    }
    return b;
  }
}
