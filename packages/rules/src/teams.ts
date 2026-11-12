/**
 * 3 vs 3 and 4 vs 4 (the Game Mode Select's 3 VS 3 / 4 VS 4, menu.ts): a Team Battle Royal
 * with one or two more wrestlers a team, run by the original team engine. The players pick
 * the four wrestlers of the original selection; the extra ones are the CPU's, with the
 * characters nobody picked.
 *
 * The extra wrestlers live in the extra slots (slots.ts: pages 6800-6E00, slot numbers 4-7). The
 * team engine reaches its wrestlers in three ways, all handled here or in the modules named:
 * - loops over the four pages (D or X from 0800 by 200, a count of 4): each gets its count and
 *   its step (after 0E00 the extras): the match start C189BC, the team frame parent C11BD3 (input
 *   C110CB, AI and targets C11D77, motion, pair resolution C12037, partner follow, camera), the
 *   contact root C1A9C7, the object loop C12299, the walk-in C1F0F9, the ring shake C216CB;
 * - tables built for four: the contact pairs (C1AAA0: every wrestler of one team against every
 *   one of the other, 4 pairs, 1A9C) are built here for 9 or 16; the referee's per-slot pin
 *   arrays (referee.ts);
 * - pointers between wrestlers: +A5 the partner, +A7 / +A9 the opponents (current and previous;
 *   a hit makes each the other's current one, C1AC99), +F0 / +F2 the two opponents a human's
 *   target choice ranks (C11DC1) and whose hit memories the contact code keeps (+FF / +101,
 *   C1AB54). With three or four opponents, `targets` keeps them on wrestlers still in: the two
 *   nearest opponents in play as +F0 / +F2, and a partner or current opponent who is out
 *   replaced by one in play (a hit still makes anyone the current opponent).
 * The extras' graphics (sprite bank 2, their palettes) are in sprites.ts, the second OAM their
 * pieces need in oamext.ts, the HUD keeps the original four.
 */
import type { Machine, Runner } from '@ssm/core';
import { chosenTeamSize } from './menu.ts';
import { cursorCharacter, picks } from './select.ts';
import { joined } from './players.ts';
import { BASE, EXT, EXTRA, bigTeams, extras, inPlay, isExtra, nextSlot, pages, prevSlot, rd16, setTeamSize, sideOf, wr16 } from './slots.ts';

const TEAM_FLAG = 0x1ba0;
const TEAM_BIT = 0x40;
/** never-executed addresses (FF padding, C07E57-C07FFF) used as return targets (items.ts: C07F00) */
const SCRIPTS_RETURN = 0xc07f10;

/** The team size the Game Mode Select chose for the team match about to start (2-4). */
export function chosenSize(c: Machine): number {
  if (!(c.wram[TEAM_FLAG]! & TEAM_BIT)) return 2;
  return Math.max(2, chosenTeamSize(c));
}

const big = bigTeams;

/** Characters (+01) of the playable cast, in the order the extras get them. */
const CAST = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * Starting places of the extra slots (x, depth), by team side and extra index: behind and
 * beside the team's two, as the original places its pairs (C0:BA4E).
 */
const START: readonly (readonly [number, number])[][] = [
  [
    [0x0e0, 0x150],
    [0x128, 0x160],
  ],
  [
    [0x1a0, 0x150],
    [0x158, 0x160],
  ],
];

const s16 = (v: number) => ((v & 0xffff) << 16) >> 16;

// ---- generic patches --------------------------------------------------------------------

/** `ADC #$0200` (16-bit, carry clear) on a slot page in A: the next slot. */
function step(r: Runner, pc: number): void {
  r.override(pc, (c) => {
    if (!big(c)) return r.original(c, pc);
    c.tick(3 * c.fast);
    c.setA(nextSlot(c, c.a & 0xffff), 16);
    c.c = false;
    c.v = false;
    return (pc & 0xff0000) | ((pc + 3) & 0xffff);
  });
}

/** `LDA / LDX / LDY #n`, a loop count: n plus the extra slots. */
function count(r: Runner, pc: number): void {
  const op = (c: Machine) => c.rom.u8(pc);
  r.override(pc, (c) => {
    if (!big(c)) return r.original(c, pc);
    const o = op(c);
    const wide = o === 0xa9 ? !c.m : !c.xf;
    const len = wide ? 3 : 2;
    c.tick(len * c.fast);
    const n = (wide ? c.rom.u8(pc + 1) | (c.rom.u8(pc + 2) << 8) : c.rom.u8(pc + 1)) + extras(c);
    const w = wide ? 16 : 8;
    if (o === 0xa9) c.setA(n, w);
    else {
      if (o === 0xa2) c.x = n & 0xffff;
      else c.y = n & 0xffff;
      c.nz(n, w);
    }
    return (pc & 0xff0000) | ((pc + len) & 0xffff);
  });
}

/** JSL from FastROM to `target`, returning to `returnTo`. */
function jsl(c: Machine, target: number, returnTo: number): number {
  c.tick(4 * c.fast + 6);
  c.push8(returnTo >>> 16);
  c.push16((returnTo - 1) & 0xffff);
  return target;
}

// ---- the match start ----------------------------------------------------------------------

/**
 * The characters of the extra slots (side e & 1): those picked on the player select
 * (select.ts), the others the first of the cast nobody has, in order. `base`: the four slots'
 * characters (before the match, the VS screen's: the selection's).
 */
export function extraChars(c: Machine, base = BASE.map((p) => c.wram[p + 0x01]!)): number[] {
  const size = chosenSize(c);
  if (size <= 2) return [];
  const n = size - 2;
  const taken = new Set(base);
  const out: number[] = Array(2 * n).fill(-1);
  for (let e = 0; e < 2 * n; e++) {
    const pick = picks(c, e & 1, n)[e >> 1]!;
    const ch = pick >= 0 && pick < CAST.length ? cursorCharacter(c, pick) : -1;
    if (ch >= 0 && !taken.has(ch)) {
      out[e] = ch;
      taken.add(ch);
    }
  }
  for (let e = 0; e < 2 * n; e++)
    if (out[e]! < 0) {
      out[e] = CAST.find((ch) => !taken.has(ch))!;
      taken.add(out[e]!);
    }
  return out;
}

/** C189BC entry: this match's size, and the extras' characters (+01, kept by C18A4A's clear). */
function matchStart(c: Machine): void {
  const size = chosenSize(c);
  setTeamSize(c, size);
  if (size <= 2) return;
  extraChars(c).forEach((ch, e) => (c.wram[EXTRA[e]! + 0x01] = ch));
  c.wram.fill(0, EXT.TILE_QUEUE, EXT.TILE_QUEUE + 6 * 4); // no frame waits (sprites.ts)
}

/**
 * C18B2C for an extra slot (D = its page, 8-bit A = its index): its team, place and opponents.
 * The base slots' sides are set already (by C18B2C, in slot order).
 */
function extraStart(c: Machine): void {
  const w = c.wram;
  const page = c.d;
  const e = EXTRA.indexOf(page as (typeof EXTRA)[number]);
  const side = e & 1; // 6800 / 6C00 with 0800's team, 6A00 / 6E00 with the other
  const mates = BASE.filter((p) => sideOf(c, p) === side);
  const opps = BASE.filter((p) => sideOf(c, p) !== side);
  wr16(c, page + 0xa5, mates[0]!);
  wr16(c, page + 0xa7, opps[0]!);
  wr16(c, page + 0xf0, opps[0]!);
  wr16(c, page + 0xa9, opps[1]!);
  wr16(c, page + 0xf2, opps[1]!);
  w[page + 0x17d] = side;
  w[page + 0x77] = joined(c, e) ? 5 + e : 0; // player 5 + e, or the CPU (players.ts)
  w[page + 0x71] = 0x38;
  w[page + 0x7c] = 0x38;
  w[page + 0x0b] = side ? 0x00 : 0x40;
  w[page + 0x86] = side ? 0x80 : 0x00;
  const [x, depth] = START[side]![e >> 1]!;
  wr16(c, page + 0x13, x);
  wr16(c, page + 0x1b, depth);
  for (const f of [0x11, 0x15, 0x17, 0x19]) wr16(c, page + f, 0);
}

function installStart(r: Runner): void {
  r.override(0xc189bc, (c) => {
    matchStart(c);
    return r.original(c, 0xc189bc);
  });
  // C189C8 STA $22: the number of slots
  r.override(0xc189c8, (c) => {
    if (!big(c)) return r.original(c, 0xc189c8);
    c.tick(2 * c.fast);
    c.wram[0x22] = 4 + extras(c);
    return 0xc189ca;
  });
  // C189F4 SEP #$30 after C18A5D: an extra slot mirrors the base slot of its number - 4 (tile
  // base and palette in bank 2, sprites.ts), and the slot-number fields that pick a colour
  r.override(0xc189f4, (c) => {
    if (big(c) && isExtra(c.d)) {
      const e = (c.d - EXTRA[0]) >> 9;
      wr16(c, c.d + 0x05, c.rom.u8(0xc0ba72 + 2 * e) | (c.rom.u8(0xc0ba73 + 2 * e) << 8));
      c.wram[c.d + 0x48] = e;
    }
    return r.original(c, 0xc189f4);
  });
  r.override(0xc18a09, (c) => {
    if (!big(c) || !isExtra(c.d)) return r.original(c, 0xc18a09);
    c.tick(3 * c.fast + 200);
    extraStart(c);
    c.setP((c.p & ~0x20) | 0x10); // as C18B2C returns: 16-bit A, 8-bit X / Y
    return 0xc18a0c;
  });
  step(r, 0xc18a1a);
}

// ---- the team frame ---------------------------------------------------------------------

/** Distance used to pick the nearest wrestlers. */
function distance(c: Machine, a: number, b: number): number {
  return Math.abs(s16(rd16(c, a + 0x13) - rd16(c, b + 0x13))) + Math.abs(s16(rd16(c, a + 0x1b) - rd16(c, b + 0x1b)));
}

/** Gone from the match: the original's own test for a target to give up (C11D9B: +76 = 0). */
const gone = (c: Machine, page: number) => c.wram[page + 0x76] === 0;

/**
 * Partners and opponents on wrestlers still in (see the header). A wrestler pinning or holding
 * someone (+D0) keeps his: the referee releases a pin a second after the fall, and the pin
 * ends if its target changes. A partner or opponent is replaced once he is gone (+76 = 0), as
 * the original's AI swaps +A7 / +A9 (C11D97).
 */
function targets(c: Machine): void {
  const all = pages(c);
  const w = c.wram;
  for (const p of all) {
    if (!(w[p]! & 0x80) || w[p + 0xd0]) continue;
    const side = sideOf(c, p);
    const byNear = (list: number[]) => list.sort((a, b) => distance(c, p, a) - distance(c, p, b) || a - b);
    const mates = byNear(all.filter((q) => q !== p && sideOf(c, q) === side && !gone(c, q)));
    const opps = byNear(all.filter((q) => sideOf(c, q) !== side && inPlay(c, q)));
    if (mates.length && gone(c, rd16(c, p + 0xa5))) wr16(c, p + 0xa5, mates[0]!);
    if (!opps.length) continue;
    const f0 = rd16(c, p + 0xf0);
    const f2 = rd16(c, p + 0xf2);
    const want = opps.slice(0, 2);
    if (want.length === 1) want.push(want[0] === f0 ? f2 : f0); // keep a pointer to one who is out
    if (!(want.includes(f0) && want.includes(f2))) {
      // keep the order of the one that stays
      if (want[1] === f0 || want[0] === f2) want.reverse();
      wr16(c, p + 0xf0, want[0]!);
      wr16(c, p + 0xf2, want[1]!);
    }
    const a7 = rd16(c, p + 0xa7);
    if (gone(c, a7)) {
      const a9 = rd16(c, p + 0xa9);
      wr16(c, p + 0xa7, !gone(c, a9) && sideOf(c, a9) !== side ? a9 : opps[0]!);
      wr16(c, p + 0xa9, a7);
    }
    if (rd16(c, p + 0xa9) === rd16(c, p + 0xa7) && opps.length > 1) {
      wr16(c, p + 0xa9, opps.find((q) => q !== rd16(c, p + 0xa7))!);
    }
  }
}

/**
 * The time-over judge of C11BD3 (C11BE3-C11CAF: the two pairs 0800 + its partner against its
 * two opponents) for teams of three or four: the same rule over the teams by side.
 */
function timeOverJudge(c: Machine): void {
  const w = c.wram;
  const all = pages(c);
  if (!all.some((p) => (w[p]! & 0x80) !== 0 && (w[p + 0xbc]! | w[p + 0xbd]!) === 0)) return;
  const sideA = sideOf(c, 0x0800);
  const a = all.filter((p) => sideOf(c, p) === sideA);
  const b = all.filter((p) => sideOf(c, p) !== sideA);
  const set = (list: number[], f: number, v: number) => list.forEach((p) => (w[p + f] = v));
  const wins = (win: number[], lose: number[]) => {
    set(win, 0xbc, 3);
    set(lose, 0xbd, 3);
    set(lose, 0xd1, 1);
  };
  const sum = (list: number[]) => list.reduce((s, p) => s + w[p + 0x79]!, 0);
  const sa = sum(a);
  const sb = sum(b);
  if (sb < sa) return wins(a, b);
  if (sb > sa) return wins(b, a);
  set(all, 0xbd, 3);
  if (sa !== 0) return;
  const active = (list: number[]) => list.filter((p) => (w[p]! & 0x80) !== 0).length;
  const ca = active(a);
  const cb = active(b);
  if (cb < ca) return wins(a, b);
  if (cb > ca) return wins(b, a);
  set(all, 0xd1, 1);
}

function installFrame(r: Runner): void {
  r.override(0xc11bd3, (c) => {
    if (big(c)) {
      c.tick(400);
      targets(c);
    }
    return r.original(c, 0xc11bd3);
  });
  // C11BE3: the time-over judge (`$1A62` set; 8-bit A, 16-bit X / Y, D = 0)
  r.override(0xc11be3, (c) => {
    if (!big(c)) return r.original(c, 0xc11be3);
    c.tick(600);
    timeOverJudge(c);
    return 0xc11cb0;
  });
  // the input gate's four slots, C110CB, C11D21 (phase 18), C11D55 (AI / targets), C11E02
  // ($1A93), C11E3A (motion), C11EAE (pair resolution), C11EE4 (partner follow), C11F26 (camera)
  for (const [n, s] of [
    [0xc11cc9, 0xc11d06],
    [0xc110cb, 0xc1113e],
    [0xc11d21, 0xc11d4a],
    [0xc11d59, 0xc11d6c],
    [0xc11e06, 0xc11e2e],
    [0xc11e3e, 0xc11ea1],
    [0xc11eb1, 0xc11edc],
    [0xc11ee8, 0xc11f1d],
    [0xc11f28, 0xc11f6a],
  ] as const) {
    count(r, n);
    step(r, s);
  }
}

// ---- contacts -------------------------------------------------------------------------------

/** C1AAA0-C1AAEF for big teams: every wrestler of one side against every one of the other. */
function contactPairs(c: Machine): void {
  const first = c.wram[0x1c8e]! & 1;
  const all = pages(c);
  const a = all.filter((p) => (c.wram[p + 0x17d]! & 0xff) === first);
  const b = all.filter((p) => (c.wram[p + 0x17d]! & 0xff) !== first);
  let at = EXT.PAIRS;
  for (const x of a)
    for (const y of b) {
      wr16(c, at, x);
      wr16(c, at + 2, y);
      at += 4;
    }
  wr16(c, EXT.PAIR_BYTES, at - EXT.PAIRS);
}

/** After the contacts: the scripts the hits asked for (+187), the extras' ones (C1AB10-C1AB45). */
function extraScripts(c: Machine, from: number): number {
  const list = EXTRA.slice(0, extras(c));
  for (let k = from; k < list.length; k++) {
    const page = list[k]!;
    const script = c.wram[page + 0x187]!;
    if (!script) continue;
    c.wram[EXT.CURSOR] = k + 1;
    c.d = page;
    c.setA(script, 8);
    return jsl(c, 0xc20168, SCRIPTS_RETURN);
  }
  // C1AB46: +141 = 0 for every wrestler (STZ $0941 ...), then PLD / RTL
  for (const page of pages(c)) c.wram[page + 0x141] = 0;
  c.tick(40);
  return 0xc1ab52;
}

function installContacts(r: Runner): void {
  // C1A9D6 REP #$30 after the four +187 clears (C1A9CA: 0987 ...)
  r.override(0xc1a9d6, (c) => {
    if (big(c)) for (const p of EXTRA.slice(0, extras(c))) c.wram[p + 0x187] = 0;
    return r.original(c, 0xc1a9d6);
  });
  // the hit-reaction loop: forward from 0800 or, with `$1C8E` bit 15 / 14, backward from the last
  count(r, 0xc1a9e1);
  r.override(0xc1a9ea, (c) => {
    if (!big(c)) return r.original(c, 0xc1a9ea);
    c.tick(3 * c.fast);
    const all = pages(c);
    c.x = all[all.length - 1]!;
    c.nz(c.x, 16);
    return 0xc1a9ed;
  });
  // C1AA30 ADC $0020: the step, +200 or -200
  r.override(0xc1aa30, (c) => {
    if (!big(c)) return r.original(c, 0xc1aa30);
    c.tick(3 * c.fast + 16);
    const back = rd16(c, 0x20) === 0xfe00;
    const page = c.a & 0xffff;
    c.setA(back ? prevSlot(c, page) : nextSlot(c, page), 16);
    c.c = false;
    return 0xc1aa33;
  });
  // the state loop
  count(r, 0xc1aa3b);
  step(r, 0xc1aa95);
  // the pairs
  r.override(0xc1aaa0, (c) => {
    if (!big(c)) return r.original(c, 0xc1aaa0);
    c.tick(900);
    contactPairs(c);
    return 0xc1aaf0;
  });
  r.override(0xc1aaf3, (c) => {
    if (!big(c)) return r.original(c, 0xc1aaf3);
    c.tick(3 * c.fast + 16);
    c.setA(rd16(c, EXT.PAIRS + c.y), 16);
    return 0xc1aaf6;
  });
  r.override(0xc1aaf7, (c) => {
    if (!big(c)) return r.original(c, 0xc1aaf7);
    c.tick(3 * c.fast + 16);
    c.x = rd16(c, EXT.PAIRS + 2 + c.y);
    c.nz(c.x, 16);
    return 0xc1aafa;
  });
  r.override(0xc1ab0b, (c) => {
    if (!big(c)) return r.original(c, 0xc1ab0b);
    c.tick(3 * c.fast);
    const d = c.y - rd16(c, EXT.PAIR_BYTES);
    c.c = d >= 0;
    c.z = d === 0;
    c.n = (d & 0x8000) !== 0;
    return 0xc1ab0e;
  });
  // C1AB46 STZ $0941 ...: first the extras' scripts, in-stream (C20168 is a JSL)
  r.override(0xc1ab46, (c) => (big(c) ? extraScripts(c, 0) : r.original(c, 0xc1ab46)));
  r.override(SCRIPTS_RETURN, (c) => {
    c.setP(c.p | 0x30);
    return extraScripts(c, c.wram[EXT.CURSOR]!);
  });
}

// ---- objects, walk-in, ring shake, CPU level ---------------------------------------------

function installObjects(r: Runner): void {
  // C12299: the wrestler object loop runs from the last slot down to 0800
  r.override(0xc1229f, (c) => {
    if (!big(c)) return r.original(c, 0xc1229f);
    c.tick(8 * c.fast);
    const all = pages(c);
    c.setA(all[all.length - 1]!, 16);
    return 0xc122aa;
  });
  // C1233A SBC #$01FF (carry clear): the slot below; C1233D CMP #$0800 ends the loop
  r.override(0xc1233a, (c) => {
    if (!big(c)) return r.original(c, 0xc1233a);
    c.tick(3 * c.fast);
    c.setA(prevSlot(c, c.a & 0xffff), 16);
    c.c = true;
    return 0xc1233d;
  });
  // the walk-in C1F0F9: step, then CMP #$1000 (slots.ts SLOTS_END after the last)
  step(r, 0xc1f10b);
  // C216F3 after the ring-shake intensity loop (C216CB: the strongest state of the four)
  r.override(0xc216f3, (c) => {
    if (big(c)) {
      for (const p of EXTRA.slice(0, extras(c))) {
        const v = c.peek8((c.db << 16) | ((0xce3a + (rd16(c, p + 0x03) >> 1)) & 0xffff));
        if (v >= rd16(c, c.d + 0x2c)) wr16(c, c.d + 0x2c, v);
      }
      c.tick(120);
    }
    return r.original(c, 0xc216f3);
  });
  // C06E7E, after the team rank's level step: the CPU level `$1B63` for the extras (as C06EA9)
  r.override(0xc06e7e, (c) => {
    if (big(c)) for (const p of EXTRA.slice(0, extras(c))) if (!c.wram[p + 0x77]) c.wram[p + 0x7a] = c.wram[0x1b63]!;
    return r.original(c, 0xc06e7e);
  });
}

export function installTeams(r: Runner): void {
  installStart(r);
  installFrame(r);
  installContacts(r);
  installObjects(r);
}

