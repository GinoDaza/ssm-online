/**
 * The extra wrestlers' characters in 3 vs 3 and 4 vs 4 (teams.ts), picked on the team's
 * player select by the human who picks the team's CPU partner.
 *
 * The original selection (ssm-disasm notes, Bank-C0 screen flow; C03876 / C03905 / C03A12):
 * `$1B86`[slot] is the select cursor (0-9, C0:A661 turns it into a character) of slot 0800 +
 * 0x200 x slot. A human first picks the wrestler of their own slot (their pad bit in `$1B85`),
 * then, if their pad bit is in `$1B9A`, the CPU partner's: slot C0:A1FA[pad + 4 x `$1B99`]. Confirming
 * the partner (C03A12: a new press of D0F0) clears the bit (C03A71 TRB `$1B9A`); when `$1B85`
 * and `$1B9A` are empty the selection ends (C03B56). The partner's side is the picker's: the
 * start places C0:B9FE give slot | 4 x `$1C88` (= `$1B99`) its side.
 *
 * Here a confirmation goes to the team's extras first: while the picker's side has extras
 * without a pick, the cursor's character is theirs (Machine.rulesBytes 0-3: side 0's two,
 * then side 1's, cursor + 1; they outlive the result screens, whose buffer is ext WRAM, until
 * the next selection) and the cursor moves on to the next free character (C03B25, Y = 1);
 * the last confirmation is the partner, as in the
 * original. A cursor skips the characters picked so far (C03B06's free exit, C03B1B), and so
 * do the CPU's wrestlers, which the VS screen takes from the stage's list skipping the
 * selection's (C041FB, its store C04226). Sides
 * nobody picks for (the CPU's team, or two humans), and picks the time ran out on, get the
 * first free characters at the match start (teams.ts).
 */
import type { Machine, Runner } from '@ssm/core';

const CURSORS = 0x1b86;
const PHASE = 0x1b99;
const PARTNER_SLOT = 0xc0a1fa;
const START_PLACES = 0xc0b9fe;
const CURSOR_CHARACTER = 0xc0a661;
/** a pick is its cursor + 1; none yet */
const NONE = 0;
/** rulesBytes: the picks, two a side */
const PICKS = 0;

const INIT_MASKS = 0xc03823;
const PARTNER_DONE = 0xc03a71;
const CURSOR_STEP = 0xc03b25;
const CURSOR_FREE = 0xc03b1b;
const CURSOR_TAKEN = 0xc03b1e;
const CPU_PICK = 0xc04226;
const CPU_NEXT = 0xc04205;

/** The cursor is one of the extras' picks. */
const picked = (c: Machine, cursor: number) => {
  for (let k = 0; k < 4; k++) if (c.rulesBytes[PICKS + k] === cursor + 1) return true;
  return false;
};

/** The character of a select cursor. */
export const cursorCharacter = (c: Machine, cursor: number) => c.rom.u8(CURSOR_CHARACTER + cursor);

/** The side (+17D) of slot `slot` when `phase` (`$1B99`, later `$1C88`) is set or not. */
const sideOfSlot = (c: Machine, slot: number, phase: number) => c.rom.u8(START_PLACES + 8 * (slot | (phase ? 4 : 0)) + 6);

/** The extras' picks of side `side` (select cursors, -1 = none), `n` at most. */
export function picks(c: Machine, side: number, n: number): number[] {
  return Array.from({ length: n }, (_, k) => c.rulesBytes[PICKS + 2 * side + k]! - 1);
}

export function installSelect(r: Runner, size: (c: Machine) => number): void {
  // C03823: the selection starts (its partner masks), no extra picked yet
  r.override(INIT_MASKS, (c) => {
    c.rulesBytes.fill(NONE, PICKS, PICKS + 4);
    return r.original(c, INIT_MASKS);
  });

  // C03A71 TRB $1B9A (8-bit, A = the pad's bit, X = the pad): his partner is confirmed
  r.split(0xc03a74);
  r.override(PARTNER_DONE, (c) => {
    const extras = size(c) - 2;
    if (extras > 0) {
      const w = c.wram;
      const pad = c.x & 0xff;
      const phase = w[PHASE]!;
      const slot = c.rom.u8(PARTNER_SLOT + pad + 4 * (phase ? 1 : 0));
      const side = sideOfSlot(c, slot, phase);
      const k = picks(c, side, extras).indexOf(-1);
      if (k >= 0) {
        c.tick(20 * c.fast);
        c.rulesBytes[PICKS + 2 * side + k] = w[CURSORS + slot]! + 1;
        // C03B25 with Y = 1: the cursor moves on to the next free character, then returns
        // (carry set, as SEC / RTS would)
        c.x = slot;
        c.y = 1;
        return CURSOR_STEP;
      }
    }
    return r.original(c, PARTNER_DONE);
  });

  // C03B1B LDX $20 / RTS: the cursor $1B86[$20] is not another slot's; nor may it be a pick
  r.split(0xc03b1d);
  r.override(CURSOR_FREE, (c) => {
    const w = c.wram;
    if (size(c) > 2 && picked(c, w[CURSORS + w[c.d + 0x20]!]!)) {
      c.tick(30 * c.fast);
      return CURSOR_TAKEN;
    }
    return r.original(c, CURSOR_FREE);
  });

  // C04226 STA $1B86,X (8-bit A = the next of the stage's list, not in the selection): a CPU
  // wrestler; a pick is taken too, the list goes on (C04205)
  r.split(0xc04229);
  r.override(CPU_PICK, (c) => {
    if (size(c) > 2 && picked(c, c.a & 0xff)) {
      c.tick(10 * c.fast);
      return CPU_NEXT;
    }
    return r.original(c, CPU_PICK);
  });
}
