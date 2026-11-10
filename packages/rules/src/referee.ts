/**
 * The team referee for 3 vs 3 and 4 vs 4 (teams.ts). The original (C10A59, each frame from
 * C00FB2, D = 1A00; ssm-disasm notes, Team referee) keeps one pin slot per wrestler k (0-3) in
 * arrays of four (`$1A04+k` the number of the wrestler k pins, bit 7 = a hold; `$1A08+k` its
 * counter) and turns a wrestler number n (1-4, `+D0` = slot + 1) into its page with
 * (2 (n - 1) + 8) << 8. For eight slots the per-slot arrays live in ext WRAM (EXT.REFEREE) and
 * the numbers 5-8 are the extra slots; the rest is the original's rule, here in TypeScript:
 *
 * - round start C10A0A: the members of each team (`+00` bit 7, by side) into `$1A16` / `$1A1A`
 *   and `$1A17` / `$1A1B`;
 * - each frame: the delay `$1A1C` (round end when it runs out), state 20 (the losers' `+D1` to
 *   `+00`), a team with no members left ends the round (C10AE5: `$1C89` = 1 if team A is out),
 *   no human left is a NO CONTEST, a time over with no pin running ends it (C10C84), else every
 *   slot: a pin starts (`+D0` set: a free counter j, timer 3C), is kicked out (sound 16), counts
 *   once a second (sounds 1E + 2 count + j) to the fall at 3 (the pinned wrestler is out, his
 *   team's `$1A1A+side` - 1, at 0 `$1A61` = 1, and `$1A6A` as the original sets it) and the
 *   release at 4 (`$1A16+side` - 1); a hold is a give up once the held wrestler's `+15E` is
 *   set; then the hold queue C10CBB (the given-up member leaves `$1A16+side` 3C frames later).
 *
 * At a time over, the life sums (C10E6E) and the judge on the counted bars (C10D3B) take every
 * member of each team (the count-up on the result screen shows the four base wrestlers').
 *
 * The counters stay the original's two (`$1A00` count, `$1A02` timer, `$1A0C` in use, `$1A0E`,
 * `$1A20` the pinner's page and `$1A24` the count for the pin-count marks C21F84): a third pin at
 * the same time waits for a free one. The hold queue's display (C10EAF, the given-up member's
 * name) is left out.
 */
import { rtl, rts, type Machine, type Runner } from '@ssm/core';
import { EXT, bigTeams, pageOf, pages, sideOf, wr16 } from './slots.ts';
import { sound } from './countout.ts';

const big = bigTeams;

/** per slot k (0-7): the number pinned (bit 7: held), and its counter */
const PIN = EXT.REFEREE;
const COUNTER = EXT.REFEREE + 8;
/** the counters, as the original's (two) */
const COUNT = 0x1a00;
const TIMER = 0x1a02;
const IN_USE = 0x1a0c;
const RELEASE = 0x1a0e;
const QUEUE = 0x1a10;
const QUEUE_TIMER = 0x1a12;
const LEFT = 0x1a16;
const FALLEN = 0x1a1a;
const DELAY = 0x1a1c;
const PINNER = 0x1a20;
const SHOWN = 0x1a24;

/** C10A0A for big teams: the members per team. */
function countMembers(c: Machine): void {
  const w = c.wram;
  w.fill(0, PIN, COUNTER + 8);
  const sideA = sideOf(c, 0x0800);
  for (const team of [0, 1]) {
    const n = pages(c).filter((p) => (sideOf(c, p) === sideA) === (team === 0) && (w[p]! & 0x80) !== 0).length;
    w[LEFT + team] = n;
    w[FALLEN + team] = n;
  }
}

/** The team index (0 = 0800's) of a wrestler page, as `$1A16+X` is indexed: by +17D. */
const team = (c: Machine, page: number) => c.wram[page + 0x17d]!;

/** C10C1D: the count's sound. */
function countSound(c: Machine, j: number): void {
  const n = c.wram[COUNT + j]!;
  if (n < 4) sound(c, (2 * n + j + 0x1e) & 0xff);
}

/** C10B2C: a pin starts or ends. */
function pinStart(c: Machine, k: number, page: number): void {
  const w = c.wram;
  const pin = w[PIN + k]!;
  const d0 = w[page + 0xd0]!;
  if (pin) {
    if (d0) return;
    sound(c, 0x16);
    w[PIN + k] = 0;
    if (pin & 0x80) return;
    const j = w[COUNTER + k]!;
    w[COUNT + j] = 0;
    w[TIMER + j] = 0;
    w[IN_USE + j] = 0;
    return;
  }
  if (!d0) return;
  if (!(d0 & 0x80)) {
    const j = w[IN_USE] === 0 ? 0 : w[IN_USE + 1] === 0 ? 1 : -1;
    if (j < 0) return; // both counters busy: try again next frame
    w[PIN + k] = d0;
    w[IN_USE + j] = 1;
    w[COUNT + j] = 0;
    w[TIMER + j] = 0x3c;
    w[COUNTER + k] = j;
    countSound(c, j);
    return;
  }
  w[PIN + k] = d0;
}

/** C10C3D: a hold; the held wrestler gives up. */
function hold(c: Machine, k: number, page: number): void {
  const w = c.wram;
  const n = w[PIN + k]! & 0x7f;
  const v = pageOf(n);
  if (!w[v + 0x15e]) return;
  w[PIN + k] = 0;
  w[v + 0xd1] = 1;
  w[v] = 1;
  const t = team(c, v);
  w[FALLEN + t] = (w[FALLEN + t]! - 1) & 0xff;
  if (w[FALLEN + t] === 0) w[0x1a61] = 1;
  w[page + 0xd0] = 0;
  const i = w[QUEUE] === 0 ? 0 : w[QUEUE + 1] === 0 ? 1 : -1;
  if (i < 0) {
    w[LEFT + t] = (w[LEFT + t]! - 1) & 0xff;
    return;
  }
  w[QUEUE + i] = n;
  w[QUEUE_TIMER + i] = 0x3c;
}

/** C10B7B: a second of a pin. */
function pinTick(c: Machine, k: number, page: number): void {
  const w = c.wram;
  const pin = w[PIN + k]!;
  if (!pin) return;
  if (pin & 0x80) return hold(c, k, page);
  const j = w[COUNTER + k]!;
  w[TIMER + j] = (w[TIMER + j]! - 1) & 0xff;
  if (w[TIMER + j] !== 0) return;
  w[COUNT + j] = (w[COUNT + j]! + 1) & 0xff;
  countSound(c, j);
  const n = w[COUNT + j];
  const v = pageOf(pin);
  if (n === 3) {
    w[TIMER + j] = 0x3c;
    w[v + 0xd1] = 1;
    w[v] = 1;
    w[v + 0x79] = 0;
    const t = team(c, v);
    w[FALLEN + t] = (w[FALLEN + t]! - 1) & 0xff;
    if (w[FALLEN + t] === 0) {
      w[0x1a61] = 1;
      if (!(w[0x7a]! & 1)) w[0x1a6a] = 1;
      return;
    }
    if (w[0x1ba4] !== 1) return;
    if (pin <= 4 && c.rom.u8(0xc08000 + pin - 1) & w[0x1ba0]!) w[0x1a6a] = 1;
    return;
  }
  if (n === 4) {
    w[RELEASE + j] = 0x3c;
    w[IN_USE + j] = 0;
    w[PIN + k] = 0;
    w[page + 0xd0] = 0;
    const t = team(c, v);
    w[LEFT + t] = (w[LEFT + t]! - 1) & 0xff;
    return;
  }
  w[TIMER + j] = 0x3c;
}

/** C10C9D: what the pin-count marks (C21F84) read. */
function shown(c: Machine, k: number, page: number): void {
  const w = c.wram;
  const pin = w[PIN + k]!;
  if (!pin || pin & 0x80) return;
  const j = w[COUNTER + k]!;
  w[SHOWN + j] = w[COUNT + j]!;
  wr16(c, PINNER + 2 * j, page);
}

/** C10CBB: the hold queue (without its display). */
function holdQueue(c: Machine): void {
  const w = c.wram;
  for (const i of [0, 1]) {
    if (!w[QUEUE + i]) continue;
    w[QUEUE_TIMER + i] = (w[QUEUE_TIMER + i]! - 1) & 0xff;
    if (w[QUEUE_TIMER + i] !== 0) continue;
    const t = team(c, pageOf(w[QUEUE + i]!));
    w[QUEUE + i] = 0;
    w[LEFT + t] = (w[LEFT + t]! - 1) & 0xff;
  }
}

/** C10AE5: the round ends. */
function roundEnd(c: Machine): void {
  const w = c.wram;
  w[0x1c89] = w[LEFT] === 0 ? 1 : 0;
  w[0x5f] = (w[0x5f]! + 1) & 0xff;
  w[0x1acc] = 0;
}

/** C10A59 for big teams. */
function referee(c: Machine): void {
  const w = c.wram;
  const all = pages(c);
  if (w[DELAY]) {
    w[DELAY] = (w[DELAY]! - 1) & 0xff;
    if (w[DELAY] === 0) return roundEnd(c);
    all.forEach((p, k) => shown(c, k, p));
    return holdQueue(c);
  }
  if (w[0x56] === 0x20) {
    if (w[0x1a64]) for (const p of all) w[p + 0xd1] = 1;
    for (const p of all) if (w[p + 0xd1]) w[p] = w[p + 0xd1]!;
    return;
  }
  if (!w[LEFT] || !w[LEFT + 1]) return roundEnd(c);
  if (!w[0x1a61] && !w[0x1c90] && !w[0x1ba4]) {
    w[0x1a64] = 1;
    w[DELAY] = 0x3c;
    return;
  }
  let pins = 0;
  for (let k = 0; k < 8; k++) pins |= w[PIN + k]!;
  if (!(w[0x1a61] || w[0x1a64] || pins) && w[0x1a65]) {
    // C10C84 carry clear: a time over
    w[0x5f] = (w[0x5f]! + 1) & 0xff;
    w[0x1a62] = 0xff;
    return;
  }
  all.forEach((p, k) => {
    pinStart(c, k, p);
    pinTick(c, k, p);
    shown(c, k, p);
  });
  holdQueue(c);
}

/** C10E6E (JSR) for big teams: the raw life sums of team A (0800's) and B, 9-bit. */
function lifeSums(c: Machine): void {
  const w = c.wram;
  const sideA = sideOf(c, 0x0800);
  const sum = (a: boolean) => pages(c).reduce((s, p) => ((sideOf(c, p) === sideA) === a ? s + w[p + 0x79]! : s), 0);
  wr16(c, 0x1a6b, sum(true));
  wr16(c, 0x1a6d, sum(false));
}

/**
 * C10D3B (JSL) for big teams: the time-over judge on the totals the result screen counted up
 * (C05B27 counts the four base wrestlers' bars), with the extras' bars (C0:9793[life]) added;
 * the losers are their whole team.
 */
function judge(c: Machine): void {
  const w = c.wram;
  const all = pages(c);
  const sideA = sideOf(c, 0x0800);
  const bars = (a: boolean) =>
    all.filter((p) => p >= 0x1000 && (sideOf(c, p) === sideA) === a).reduce((s, p) => s + c.rom.u8(0xc09793 + w[p + 0x79]!), 0);
  const ta = (w[0x1a6b]! | (w[0x1a6c]! << 8)) + bars(true);
  const tb = (w[0x1a6d]! | (w[0x1a6e]! << 8)) + bars(false);
  if (ta === tb) {
    if (ta !== 0 && !w[0x1acc]) {
      w[0x1acc] = (w[0x1acc]! + 1) & 0xff;
      w[0xd6]! |= 0x08;
      return;
    }
    w[0xd6]! |= 0x08;
    w[0x1acc] = 0;
    w[0x1a64] = 1;
    for (const p of all) w[p] = 1;
    for (const p of all) w[p + 0xd1] = 0;
    return;
  }
  const bWins = tb >= ta ? 1 : 0;
  w[0x1c89] = bWins;
  w[0x1acc] = 0;
  for (const p of all) {
    if ((sideOf(c, p) === sideA) !== (bWins === 1)) continue;
    w[p] = 1;
    w[p + 0xd1] = 0;
  }
}

export function installReferee(r: Runner): void {
  r.override(0xc10e6e, (c) => {
    if (!big(c)) return r.original(c, 0xc10e6e);
    c.tick(200);
    lifeSums(c);
    return rts(c);
  });
  r.override(0xc10d3b, (c) => {
    if (!big(c)) return r.original(c, 0xc10d3b);
    c.tick(300);
    judge(c);
    c.setP(c.p | 0x20);
    return rtl(c);
  });
  // C10A0A (round start, team): the members
  r.override(0xc10a0a, (c) => {
    if (!big(c)) return r.original(c, 0xc10a0a);
    c.tick(300);
    countMembers(c);
    c.setP(c.p | 0x30);
    return rtl(c);
  });
  // C10A55 JSR C10A59 / RTL: the frame
  r.override(0xc10a55, (c) => {
    if (!big(c)) return r.original(c, 0xc10a55);
    c.tick(1200);
    referee(c);
    c.setP((c.p | 0x20) & ~0x10);
    return rtl(c);
  });
}

