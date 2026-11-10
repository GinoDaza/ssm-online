/**
 * The wrestler slots of a match. The original has four (team play; singles use the first two),
 * pages of 0x200 bytes at 0800-0FFF, run with D = the page. 3 vs 3 and 4 vs 4 (teams.ts) add up
 * to four more. Low WRAM has no room for them (0000-1FFF is used up to the stack's last
 * bytes), so they live at 6800-6FFF of bank 0, which Machine.ramExt maps to WRAM 7E:6800 (the
 * game leaves 7E:6000-7FFF alone from the menus to the end of a match, but for three bytes at
 * 6000; the results and continue screens (C0578B..) use it as a buffer). The rules' state of a
 * match lives in the same window (EXT), so rollback snapshots hold it; the match's team size,
 * which must outlive those screens, is in Machine.rulesWord.
 *
 * A slot's number (+78, set by the match start C18A5D) is 0-3 in the original; the extra slots
 * are 4-7. The game's wrestler number (pins, `+D0`) is the slot number + 1.
 */
import type { Machine } from '@ssm/core';

export const BASE = [0x0800, 0x0a00, 0x0c00, 0x0e00] as const;
export const EXTRA = [0x6800, 0x6a00, 0x6c00, 0x6e00] as const;
/** the step after the last slot, as the original loops see it after 0E00 */
export const SLOTS_END = 0x1000;

/** ext WRAM (Machine.ramExt), 7E:6400-67FF: the rules' state */
export const EXT = {
  /** byte: the OAM pass is filling the second OAM (oamext.ts) */
  OAM_PHASE: 0x6401,
  /** word: bytes used in PAIRS */
  PAIR_BYTES: 0x6402,
  /** byte: the next extra slot of a chain of calls (teams.ts) */
  CURSOR: 0x6404,
  /** contact pairs (teams.ts): attacker page, defender page, 16 at most */
  PAIRS: 0x6410,
  /** the team referee for eight slots (referee.ts) */
  REFEREE: 0x6460,
  /** the OAM buffer 7E:3200-341F while the second OAM is drawn (oamext.ts) */
  OAM_STASH: 0x6500,
  /** the extra slots' sprite palettes, 4 x 16 colors (bank 2's palettes 4-7) */
  PALETTES: 0x6780,
} as const;

/** rulesWord bits 8-9: the team size of the match now on, less 2 (menu.ts owns bits 0-2) */
const SIZE_SHIFT = 8;

/** The team size of this match: 2 (the original) or 3 / 4 (teams.ts). */
export const teamSize = (c: Machine) => 2 + ((c.rulesWord >> SIZE_SHIFT) & 3);
/** A 3 vs 3 or 4 vs 4 match is on. */
export const bigTeams = (c: Machine) => teamSize(c) > 2;

export function setTeamSize(c: Machine, n: number): void {
  c.rulesWord = (c.rulesWord & ~(3 << SIZE_SHIFT)) | ((Math.max(2, n) - 2) << SIZE_SHIFT);
}
/** extra slots in this match */
export const extras = (c: Machine) => 2 * (teamSize(c) - 2);

/** The wrestler pages of this match (team play: the four, then the extras). */
export function pages(c: Machine): number[] {
  const n = extras(c);
  return n ? [...BASE, ...EXTRA.slice(0, n)] : [...BASE];
}

export const isExtra = (page: number) => page >= EXTRA[0] && page < EXTRA[0] + 4 * 0x200;

/** The slot after `page` (SLOTS_END after the last). */
export function nextSlot(c: Machine, page: number): number {
  const all = pages(c);
  const k = all.indexOf(page);
  return k >= 0 && k + 1 < all.length ? all[k + 1]! : k >= 0 ? SLOTS_END : (page + 0x200) & 0xffff;
}

/** The slot before `page` (0600 before 0800, as the original's downward loops end). */
export function prevSlot(c: Machine, page: number): number {
  const all = pages(c);
  const k = all.indexOf(page);
  return k > 0 ? all[k - 1]! : (page - 0x200) & 0xffff;
}

/** The page of a wrestler number (1-8: slot + 1). */
export function pageOf(n: number): number {
  return n <= 4 ? 0x0800 + 0x200 * (n - 1) : EXTRA[n - 5]!;
}

/** The team side of a wrestler page (+17D: 0 = 0800's team). */
export const sideOf = (c: Machine, page: number) => c.wram[page + 0x17d]! & 1;

/** In play (+76) and active (+00 bit 7). */
export const inPlay = (c: Machine, page: number) => c.wram[page + 0x76] !== 0 && (c.wram[page]! & 0x80) !== 0;

export const rd16 = (c: Machine, a: number) => c.wram[a]! | (c.wram[a + 1]! << 8);
export function wr16(c: Machine, a: number, v: number): void {
  c.wram[a] = v & 0xff;
  c.wram[a + 1] = (v >> 8) & 0xff;
}
