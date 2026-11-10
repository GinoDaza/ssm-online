/**
 * Players 5-8 in 3 vs 3 and 4 vs 4: humans for the extra wrestlers, with the pads beyond the
 * console's four (Machine.padsx, fed like the others by the host and the netplay session).
 * Player 5 + e plays extra e (slots.ts: 6800 + 0x200 x e, side e & 1: 5P and 7P with pad 1's
 * team, 6P and 8P against it). Their state is in Machine.rulesBytes (RULES_BYTES).
 *
 * - Joining: on the Team Battle Royal entry (ENTER THE MATCH!, its countdown C031A2), a new
 *   press of START joins the player (menus.ts draws the boxes). The entry is shown for a
 *   3 VS 3 / 4 VS 4 even with four humans (C03197: the original skips it then). Who joined
 *   stays until the next Game Mode Select.
 * - Picking: on the team player select a joined player picks their extra's character in the
 *   margin (menus.ts shows "5P" and the cursor's name): left / right move the cursor over the
 *   free characters, a new press of a confirm button (D0F0, as C03A12) picks. The selection
 *   waits for them (C038BA), until its time runs out; an extra without a pick gets the first
 *   free character at the match start (teams.ts). The partner's picker skips their extras
 *   (select.ts).
 * - Playing: the extra's +77 is the player's number (5-8; 0 is the CPU, which every reader
 *   of +77 but the input gate only tells apart). The input gate C110CB builds a human's
 *   held (+91) and new (+93) words from pad +77's word at `$B0` and that pad's button
 *   assignment at `$03B2` (three bytes a pad, the options' C01B48); players 5-8 have no
 *   words there, so their extras' are built here from Machine.padsx, with pad 1's assignment.
 */
import type { Machine, Runner } from '@ssm/core';
import { RULES_BYTES, isExtra } from './slots.ts';

const START = 0x1000;
const LEFT = 0x0200;
const RIGHT = 0x0100;
/** the select's confirm buttons (C03A12: BIT #$D0F0) */
const CONFIRM = 0xd0f0;
const CAST = 10;
const CURSORS_1B86 = 0x1b86;
const STATE = 0x56;
const SELECT_STATE = 0x0c;
/** pad 1's button assignment: three bytes, one an action, of button bits as C110CB tests them */
const ASSIGNMENT = 0x03b2;

/** Player 5 + e has joined. */
export const joined = (c: Machine, e: number) => ((c.rulesBytes[RULES_BYTES.JOINED]! >> e) & 1) !== 0;

/** Who joined is forgotten (a new Game Mode Select). */
export function resetPlayers(c: Machine): void {
  c.rulesBytes[RULES_BYTES.JOINED] = 0;
  c.rulesBytes.fill(0, RULES_BYTES.CURSORS, RULES_BYTES.CURSORS + 4);
}

/** Player 5 + e's select cursor (-1: not shown yet). */
export const playerCursor = (c: Machine, e: number) => c.rulesBytes[RULES_BYTES.CURSORS + e]! - 1;

const pick = (c: Machine, e: number) => c.rulesBytes[RULES_BYTES.PICKS + 2 * (e & 1) + (e >> 1)]! - 1;

/** The cursors no one else may take: the four slots' (0-9) and every pick. */
function taken(c: Machine): Set<number> {
  const out = new Set<number>();
  for (let s = 0; s < 4; s++) if (c.wram[CURSORS_1B86 + s]! < CAST) out.add(c.wram[CURSORS_1B86 + s]!);
  for (let k = 0; k < 4; k++) if (c.rulesBytes[RULES_BYTES.PICKS + k]) out.add(c.rulesBytes[RULES_BYTES.PICKS + k]! - 1);
  return out;
}

/** The next free cursor from `from` in direction `dir` (from itself when dir = 0). */
function free(c: Machine, from: number, dir: number): number {
  const t = taken(c);
  let v = from;
  for (let n = 0; n < CAST; n++) {
    if (dir) v = (v + dir + CAST) % CAST;
    if (!t.has(v)) return v;
    if (!dir) dir = 1;
  }
  return from;
}

/** A joined player whose extra has no pick yet (the selection waits for them). */
export function picking(c: Machine, size: number): boolean {
  for (let e = 0; e < 2 * (size - 2); e++) if (joined(c, e) && pick(c, e) < 0) return true;
  return false;
}

/**
 * Once a frame outside a match: players 5-8 join on the entry screen (`entry`) and pick on the
 * team player select. `size`: the chosen team size.
 */
export function playersFrame(c: Machine, size: number, entry: boolean): void {
  const rb = c.rulesBytes;
  const n = size > 2 ? 2 * (size - 2) : 0;
  for (let e = 0; e < 4; e++) {
    const at = RULES_BYTES.LAST_PADS + 2 * e;
    const pad = c.padsx[e]!;
    const fresh = pad & ~(rb[at]! | (rb[at + 1]! << 8));
    rb[at] = pad & 0xff;
    rb[at + 1] = pad >> 8;
    if (e >= n) continue;
    if (entry && fresh & START) rb[RULES_BYTES.JOINED]! |= 1 << e;
    if (c.wram[STATE] !== SELECT_STATE || !joined(c, e) || pick(c, e) >= 0) continue;
    const cursor = RULES_BYTES.CURSORS + e;
    if (!rb[cursor]) rb[cursor] = free(c, 0, 0) + 1;
    if (fresh & (LEFT | RIGHT)) rb[cursor] = free(c, rb[cursor]! - 1, fresh & RIGHT ? 1 : -1) + 1;
    const v = rb[cursor]! - 1;
    if (taken(c).has(v)) rb[cursor] = free(c, v, 1) + 1;
    else if (fresh & CONFIRM) rb[RULES_BYTES.PICKS + 2 * (e & 1) + (e >> 1)] = v + 1;
  }
}

/** Player 5 + e's held word for C110CB: directions, then the three actions (bits 4-6...). */
function heldWord(c: Machine, pad: number): number {
  const w = c.wram;
  const lo = pad & 0xff;
  const hi = pad >> 8;
  const a = ((lo >> 2) | (hi & 0xc0)) & 0xff;
  // C1110B-C11128: three BIT tests of the assignment, rotated in through the carry
  let v = 0;
  let carry = 0;
  const ror = (x: number) => {
    const out = x & 1;
    const r = (x >> 1) | (carry << 7);
    carry = out;
    return r;
  };
  carry = a & w[ASSIGNMENT]! ? 1 : 0;
  v = ror(v);
  carry = carry || a & w[ASSIGNMENT + 1]! ? 1 : 0;
  v = ror(v);
  carry = carry || a & w[ASSIGNMENT + 2]! ? 1 : 0;
  let acc = v;
  acc = ror(acc);
  acc = ror(acc);
  return (hi & 0x0f) | acc;
}

export function installPlayers(r: Runner, size: (c: Machine) => number): void {
  // C03197 LDA $1BA4 / CMP #$04 / BEQ (no entry with four humans): a 3 VS 3 / 4 VS 4 shows it
  r.override(0xc03197, (c) => {
    if (c.wram[0x1ba4] !== 4 || size(c) <= 2) return r.original(c, 0xc03197);
    c.tick(4 * c.fast + 4);
    return 0xc0319e;
  });
  // C038BA LDA $1B85 / ORA $1B9A / BNE C038C5: the selection also waits for players 5-8
  r.override(0xc038ba, (c) => {
    if (size(c) <= 2 || !picking(c, size(c))) return r.original(c, 0xc038ba);
    c.tick(4 * c.fast + 4);
    return 0xc038c5;
  });
  // C110E9 LDA $77 (8-bit; D = the wrestler): players 5-8's extras read Machine.padsx
  r.split(0xc110eb);
  r.override(0xc110e9, (c) => {
    const w = c.wram;
    const d = c.d;
    const p = w[d + 0x77]!;
    if (p < 5 || !isExtra(d)) return r.original(c, 0xc110e9);
    c.tick(60 * c.fast);
    const held = heldWord(c, c.padsx[p - 5]!);
    w[d + 0x91] = held;
    w[d + 0x93] = (held ^ w[d + 0x92]!) & held;
    return 0xc1113a;
  });
}
