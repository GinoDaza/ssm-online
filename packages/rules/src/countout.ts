/**
 * Count-out for team matches in the singles arena. In singles the referee counts a wrestler
 * outside the ring (C1094C, one count a second): at 20 he loses (COUNT OUT), both outside lose
 * both (DOUBLE COUNT OUT); the count is shown as a banner (C10000: BG3 band `$0602`, digits
 * through the graphics ring, entry 4B + count, 06 clears) with the referee's voice. Team play
 * has no referee (its slot 0C00 is the third wrestler), so this count runs without one, the
 * same rule per team:
 * - each second of the match clock (C06214) while an active wrestler stands outside (+152, the
 *   wrestler's own flag the singles referee reads), `$1A60` (the singles count, unused in team
 *   play) goes up and its digit shows; with nobody outside it goes back to 0 and the banner is
 *   cleared: the band off (`$0602` = 0, as C10000's request 00) and the digits blanked with ring
 *   entry 60 (entry 06 is not a clear: it draws the pin banner's "PIN" there, which the band of
 *   the "x:xx PASSED" message, `$E9` bit 7, would then show);
 * - at 20, a team with a member outside loses: its members left (`$1A16` / `$1A17`) go to 0, so
 *   the team referee ends the round as after a last pin fall (C10AE5: winner `$1C89`). The
 *   losers are marked like the time-over judge does (+00 = 1, +D1 = 0; the result flow reads
 *   it), but only after the message (C021E7): marked earlier, the team code moves them to the
 *   back of the ring as eliminated wrestlers while the round end is on screen. Both teams
 *   outside: both lose
 *   (`$1A64`, as a no contest). `$1A62` = 1 / `$1A63` = 1 select the singles message (COUNT OUT /
 *   DOUBLE COUNT OUT, C069F8: an arena site in overrides.ts); C021E7 clears `$1A62` again before
 *   the team flow reads it as a time over.
 */
import type { Machine, Runner } from '@ssm/core';
import { bigTeams, pages, sideOf } from './slots.ts';

const TEAM_FLAG = 0x1ba0;
const TEAM_BIT = 0x40;
const COUNT = 0x1a60;
const COUNT_OUT = 0x1a62;
const DOUBLE_COUNT_OUT = 0x1a63;
const NO_CONTEST = 0x1a64;
const PIN_FALL = 0x1a61;
const MEMBERS_LEFT = [0x1a16, 0x1a17] as const;
const LIMIT = 20;
/** graphics ring entry: the count banner's five BG3 rows blank */
const BLANK = 0x60;
/** the fight state of `$56`, and `$5F` (a round end is pending when nonzero) */
const FIGHT = 0x1a;

const isTeam = (c: Machine) => (c.wram[TEAM_FLAG]! & TEAM_BIT) !== 0;

/** Team A (with 0800) and team B, by the pairing `$1C88` (C10E6E); bigger teams by side. */
function teams(c: Machine): [number[], number[]] {
  if (bigTeams(c)) {
    const a = sideOf(c, 0x0800);
    const all = pages(c);
    return [all.filter((p) => sideOf(c, p) === a), all.filter((p) => sideOf(c, p) !== a)];
  }
  return c.wram[0x1c88] === 0 ? [[0x800, 0xa00], [0xc00, 0xe00]] : [[0x800, 0xc00], [0xa00, 0xe00]];
}

const outside = (c: Machine, d: number) => c.wram[d + 0x76] !== 0 && c.wram[d + 0x152] !== 0;

/** C2031B: a pose into the graphics ring 1E40. */
function pose(c: Machine, entry: number): void {
  const x = c.wram[0xfd]!;
  c.wram[0x1e40 + x] = entry;
  c.wram[0xfd] = (x + 1) & 0x1f;
}

/** C00B2C: a sound into the queue 03E0. */
export function sound(c: Machine, id: number): void {
  const x = c.wram[0xfe]!;
  c.wram[0x3e0 + x] = id;
  c.wram[0x3e1 + x] = 0;
  c.wram[0xfe] = (x + 2) & 0x1e;
}

/** One second of the clock. */
function tick(c: Machine): void {
  const w = c.wram;
  if (w[0x56] !== FIGHT || w[0x5f] !== 0 || w[PIN_FALL] || w[NO_CONTEST] || w[COUNT_OUT] || w[DOUBLE_COUNT_OUT]) return;
  const out = teams(c).map((team) => team.some((d) => outside(c, d)));
  if (!out[0] && !out[1]) {
    if (w[COUNT]) {
      w[COUNT] = 0;
      w[0x602] = 0;
      w[0x603] = 0;
      pose(c, BLANK);
    }
    return;
  }
  const n = w[COUNT]! + 1;
  w[COUNT] = n;
  pose(c, 0x4b + n);
  if (n < LIMIT) {
    sound(c, n < 18 ? 0x2e : 0x2f);
    return;
  }
  sound(c, 0x17);
  out.forEach((o, k) => {
    if (o) w[MEMBERS_LEFT[k]!] = 0;
  });
  if (out[0] && out[1]) {
    w[DOUBLE_COUNT_OUT] = 1;
    w[NO_CONTEST] = 1;
  } else w[COUNT_OUT] = 1;
}

/** The banner while the count runs (C10000 does it in singles): which side is watched. */
function banner(c: Machine): void {
  const w = c.wram;
  if (w[COUNT] === 0 || w[0x56] !== FIGHT) return;
  const side = teams(c)[0].some((d) => outside(c, d)) ? 0 : 2; // as the referee's +C1
  const at = 0xc0ab58 + side;
  w[0x602] = c.rom.u8(at);
  w[0x603] = c.rom.u8(at + 1);
  w[0xe9]! |= 0x80;
}

export function installCountOut(r: Runner): void {
  r.split(0xc06216);
  r.override(0xc06214, (c) => {
    if (isTeam(c)) tick(c);
    return r.original(c, 0xc06214);
  });

  // C10006 follows the clear of `$E9` bit 7 in C10000; team play skips the banner after it
  r.split(0xc10009);
  r.override(0xc10006, (c) => {
    if (isTeam(c)) banner(c);
    return r.original(c, 0xc10006);
  });

  // after the round-end message: mark the losers; the team flow would read `$1A62` as a time
  // over (C02200)
  r.split(0xc021e9);
  r.override(0xc021e7, (c) => {
    const w = c.wram;
    if (isTeam(c) && (w[COUNT_OUT] === 1 || w[DOUBLE_COUNT_OUT])) {
      w[COUNT_OUT] = 0;
      teams(c).forEach((team, k) => {
        if (w[MEMBERS_LEFT[k]!] !== 0) return;
        for (const d of team) {
          w[d] = 1;
          w[d + 0xd1] = 0;
        }
      });
    }
    return r.original(c, 0xc021e7);
  });
}
