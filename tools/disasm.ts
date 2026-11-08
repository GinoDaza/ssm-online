/**
 * Linear 65816 disassembly of the ROM, for writing overrides:
 *   npx tsx tools/disasm.ts <address hex> [count=40] [m8] [x8]
 * The widths start 16-bit (the wrestler code runs REP #30) unless m8 / x8 are given, and
 * follow REP / SEP as they come; after a branch target the guess may be wrong.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OPCODES, operandSize } from '../packages/core/src/cpu/opcodes.ts';

const rom = readFileSync(resolve(import.meta.dirname, '../roms/Saturday Night Slam Masters (USA).sfc'));
let pc = parseInt(process.argv[2] ?? 'C00000', 16);
const count = Number(process.argv[3] ?? 40);
let m8 = process.argv.includes('m8');
let x8 = process.argv.includes('x8');

const rd = (a: number) => rom[a & 0x3fffff]!;
const hex = (v: number, w: number) => '$' + v.toString(16).toUpperCase().padStart(w, '0');

for (let k = 0; k < count; k++) {
  const op = OPCODES[rd(pc)]!;
  const n = operandSize(op.mode, m8, x8);
  let v = 0;
  for (let i = n; i >= 1; i--) v = (v << 8) | rd(pc + i);
  const bank = pc & 0xff0000;
  const next = (pc + 1 + n) & 0xffff;
  const arg: Record<string, () => string> = {
    imp: () => '',
    immM: () => '#' + hex(v, 2 * n),
    immX: () => '#' + hex(v, 2 * n),
    imm8: () => '#' + hex(v, 2),
    dp: () => hex(v, 2),
    dpx: () => hex(v, 2) + ',X',
    dpy: () => hex(v, 2) + ',Y',
    ind: () => `(${hex(v, 2)})`,
    indl: () => `[${hex(v, 2)}]`,
    indy: () => `(${hex(v, 2)}),Y`,
    indly: () => `[${hex(v, 2)}],Y`,
    indx: () => `(${hex(v, 2)},X)`,
    sr: () => hex(v, 2) + ',S',
    sry: () => `(${hex(v, 2)},S),Y`,
    abs: () => hex(v, 4),
    absx: () => hex(v, 4) + ',X',
    absy: () => hex(v, 4) + ',Y',
    long: () => hex(v, 6),
    longx: () => hex(v, 6) + ',X',
    rel8: () => hex(bank | ((next + ((v << 24) >> 24)) & 0xffff), 6),
    rel16: () => hex(bank | ((next + ((v << 16) >> 16)) & 0xffff), 6),
    absind: () => `(${hex(v, 4)})`,
    absindx: () => `(${hex(v, 4)},X)`,
    absindl: () => `[${hex(v, 4)}]`,
    blk: () => `${hex(v & 0xff, 2)},${hex(v >> 8, 2)}`,
  };
  console.log(`${hex(pc, 6).slice(1)}  ${op.mn} ${arg[op.mode]!()}`);
  if (op.mn === 'REP') {
    if (v & 0x20) m8 = false;
    if (v & 0x10) x8 = false;
  } else if (op.mn === 'SEP') {
    if (v & 0x20) m8 = true;
    if (v & 0x10) x8 = true;
  }
  pc = bank | next;
}
