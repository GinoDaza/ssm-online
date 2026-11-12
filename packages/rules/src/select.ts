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
 *
 * The picker's marker (C20A42, a bank-C2 pool object a pad: "1P" over "COM") follows the
 * partner's cursor, x = C0:C9F1[cursor]; when it adds itself to draw list 1 (C20AC9, JMP
 * C20038: its page at 0700 + `$F6`, its depth +1B at 0640 + `$F6`) a copy of it goes there too
 * for each extra its side picked, at that pick's x, so every picked portrait keeps the mark.
 * The copies are whole 0x40-byte objects in ext WRAM (MARKS, free during the menus). The
 * marker blinks while its player picks (C20ACC: its colour, sprite palette 1's 10 + pad, white
 * on some frames); the copies do not: they use sprite palette 0, which nothing on the screen
 * uses, kept a copy of palette 1 with that colour at the marker's base colour (+12).
 */
import type { Machine, Runner } from '@ssm/core';
import { joined } from './players.ts';
import { RULES_BYTES } from './slots.ts';

const CURSORS = 0x1b86;
const PHASE = 0x1b99;
const PARTNER_SLOT = 0xc0a1fa;
const START_PLACES = 0xc0b9fe;
const CURSOR_CHARACTER = 0xc0a661;
/** a pick is its cursor + 1; none yet */
const NONE = 0;
const PICKS = RULES_BYTES.PICKS;

const INIT_MASKS = 0xc03823;
const PARTNER_DONE = 0xc03a71;
const CURSOR_STEP = 0xc03b25;
const CURSOR_FREE = 0xc03b1b;
const CURSOR_TAKEN = 0xc03b1e;
const CPU_PICK = 0xc04226;
const CPU_NEXT = 0xc04205;

const MARK_LISTED = 0xc20ac9;
const MARK_X = 0xc0c9f1;
/** the marker copies, one a pick (ext WRAM, unused before a match) */
const MARKS = 0x6200;
const OBJECT_BYTES = 0x40;
const DRAW_COUNT = 0xf6;
const DRAW_PAGES = 0x0700;
const DRAW_DEPTHS = 0x0640;
const DRAW_MAX = 0x40;
/** the sprite palettes' buffer (7E:3100: palette 0, 3120: palette 1), uploaded when `$D5` is set */
const OBJ_PALETTES = 0x3100;
const PALETTE_BYTES = 0x20;
const MARK_COLOUR = 10;
const PALETTES_DIRTY = 0xd5;
/** OAM attribute bits 1-3: the palette */
const PALETTE_BITS = 0x0e;

/** Sprite palette 0 = palette 1 with the marker's colour of `pad` steady at `base`. */
function steadyPalette(c: Machine, pad: number, base: number): void {
  const w = c.wram;
  let changed = false;
  for (let i = 0; i < PALETTE_BYTES; i++) {
    let v = w[OBJ_PALETTES + PALETTE_BYTES + i]!;
    if (i >> 1 === MARK_COLOUR + pad) v = i & 1 ? base >> 8 : base & 0xff;
    if (w[OBJ_PALETTES + i] !== v) {
      w[OBJ_PALETTES + i] = v;
      changed = true;
    }
  }
  if (changed) w[PALETTES_DIRTY] = 1;
}

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
    c.rulesBytes.fill(0, RULES_BYTES.CURSORS, RULES_BYTES.CURSORS + 4);
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
      // the next extra of the side without a pick, players 5-8's left to them (players.ts)
      const k = picks(c, side, extras).findIndex((p, k) => p < 0 && !joined(c, 2 * k + side));
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

  // C20AC9 JMP C20038 (D = the pad's marker, +02 the pad): its copies at the side's picks
  r.override(MARK_LISTED, (c) => {
    const extras = size(c) - 2;
    if (extras > 0) {
      const w = c.wram;
      const d = c.d;
      const pad = w[d + 0x02]! & 3;
      const phase = w[PHASE]!;
      const side = sideOfSlot(c, c.rom.u8(PARTNER_SLOT + pad + 4 * (phase ? 1 : 0)), phase);
      let steady = false;
      picks(c, side, extras).forEach((p, k) => {
        // players 5-8's picks are theirs, not the marker's player's
        if (p < 0 || joined(c, 2 * k + side)) return;
        const n = w[DRAW_COUNT]!;
        if (n >= DRAW_MAX) return;
        const copy = MARKS + OBJECT_BYTES * (2 * side + k);
        c.tick(80 * c.fast);
        w.copyWithin(copy, d, d + OBJECT_BYTES);
        w[copy + 0x07] = c.rom.u8(MARK_X + p);
        w[copy + 0x06] = w[copy + 0x06]! & ~PALETTE_BITS;
        steady = true;
        w[DRAW_PAGES + n] = copy & 0xff;
        w[DRAW_PAGES + n + 1] = copy >> 8;
        w[DRAW_DEPTHS + n] = w[copy + 0x1b]!;
        w[DRAW_DEPTHS + n + 1] = w[copy + 0x1c]!;
        w[DRAW_COUNT] = n + 2;
      });
      if (steady) steadyPalette(c, pad, w[d + 0x12]! | (w[d + 0x13]! << 8));
    }
    return r.original(c, MARK_LISTED);
  });
}
