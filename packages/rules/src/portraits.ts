/**
 * The extras' portraits on the team player select of a 3 VS 3 or 4 VS 4: each picked extra (and
 * the character under a player 5-8's cursor while they pick) shows in the margin of its side as
 * the four wrestlers of the original show on the screen, side 0's on the left, side 1's on the
 * right, the side's first extra level with the upper portraits, the second with the lower ones.
 *
 * The original's portraits (ssm-disasm notes, Code-selected palettes and portraits) are BG1:
 * C04244 maps a character's 10 x 10 tile map (u24 pointers C0:A307, the first ten) at a place of
 * the table C0:A36B, only its columns 1-8 on this screen (flag bit 7), mirrored on side 1 (bit 6,
 * H-flip), the tiles of WRAM list 14 + character (C043FE), the colours C043A5: 16 from the
 * character's block in bank CB (word pointers C0:A2EF) at the team offset of the slot,
 * C0:A303[slot]. BG1's map cannot hold more (its margins show its own other side), so here they
 * are sprites: 16 x 16 pieces (OBSEL 3: 8 / 16) in the second OAM (oamext.ts: drawn below the
 * OAM's), with their real x in the margins, taking their tiles from sprite bank 2 (unused
 * before a match, which loads its own) and their colours from bank 2's palettes 4-7 (EXT.PALETTES,
 * which are bank 2's in team play, sprites.ts). Extra e mirrors slot e (its colours in a match,
 * sprites.ts), so its portrait has slot e's team colours; its tiles take bank 2's tiles from
 * 160 x e, laid out as 16 x 16 sprites read them, mirrored there on side 1. The names stay BG3
 * (menus.ts), over the portraits' lower edge as the original's.
 */
import { OBJX_BANK2, type Machine } from '@ssm/core';
import { chosenTeamSize } from './menu.ts';
import { Screen, screenOf } from './menus.ts';
import { joined, playerCursor } from './players.ts';
import { cursorCharacter, picks } from './select.ts';
import { EXT } from './slots.ts';
import { WRAM_LISTS, vramList } from './sprites.ts';

const MAPS = 0xc0a307;
const PALETTE_POINTERS = 0xc0a2ef;
const TEAM_ROWS = 0xc0a303;
const PORTRAIT_LIST = 14;
const MAP_COLS = 10;
const COLS = 8;
const ROWS = 10;
/** the screen's portraits: BG1 rows 3-12 and 13-22 */
const TOP = [24, 104] as const;
const WIDTH = 8 * COLS;
/** bank 2 tile rows a portrait takes (16 tiles a row: two portraits side by side) */
const TILE_ROWS = 10;
/** what portrait e's bank-2 tiles show: character + 1 (0 = nothing yet), ext WRAM */
export const SHOWN = 0x6300;
/** OAM attributes: priority 3, bank 2's palettes 4-7 */
const PRIORITY = 0x30;
const PALETTE0 = 4;
/** Machine.oamx: bank 2 (bit 2), a real x (bit 1) */
const FLAGS = 4 | 2;
const SECOND_OAM = 128;
const TEAM_FLAG = 0x1ba0;
const TEAM_BIT = 0x40;
const PALETTES_DIRTY = 0xd5;

const rev = (b: number) => {
  let r = 0;
  for (let k = 0; k < 8; k++) r |= ((b >> k) & 1) << (7 - k);
  return r;
};

/** The first tile of portrait e in bank 2. */
const firstTile = (e: number) => (e >> 1) * 16 * TILE_ROWS + (e & 1) * COLS;

/** Portrait e (side e & 1) of character `ch` into bank 2: tiles and palette. */
function load(c: Machine, e: number, ch: number): void {
  const tiles = vramList(c, PORTRAIT_LIST + ch, WRAM_LISTS)[0]!.data;
  const rom = c.rom;
  const map = rom.u8(MAPS + 3 * ch) | (rom.u8(MAPS + 3 * ch + 1) << 8) | (rom.u8(MAPS + 3 * ch + 2) << 16);
  const mirror = (e & 1) === 1;
  const t0 = firstTile(e);
  for (let r = 0; r < ROWS; r++)
    for (let k = 0; k < COLS; k++) {
      const src = 32 * rom.u8(map + MAP_COLS * r + (mirror ? COLS - k : 1 + k));
      const dst = OBJX_BANK2 + 32 * (t0 + 16 * r + k);
      for (let i = 0; i < 32; i++) {
        const v = tiles[src + i] ?? 0;
        c.objx[dst + i] = mirror ? rev(v) : v;
      }
    }
  const colours = 0xcb0000 | rom.u8(PALETTE_POINTERS + 2 * ch) | (rom.u8(PALETTE_POINTERS + 2 * ch + 1) << 8);
  const at = colours + rom.u8(TEAM_ROWS + e);
  for (let i = 0; i < 32; i++) c.wram[EXT.PALETTES + 32 * e + i] = rom.u8(at + i);
  c.wram[PALETTES_DIRTY] = 1;
  c.wram[SHOWN + e] = ch + 1;
}

/** The selection starts: no portrait loaded (bank 2 may hold a match's tiles). */
export function resetPortraits(c: Machine): void {
  c.wram.fill(0, SHOWN, SHOWN + 4);
}

/** At the OBJ pass tail outside big matches (oamext.ts): the extras' portraits, second OAM. */
export function portraitSprites(c: Machine): void {
  if (screenOf(c) !== Screen.TEAM_SELECT || !(c.wram[TEAM_FLAG]! & TEAM_BIT) || !c.wide) return;
  const size = chosenTeamSize(c);
  if (size <= 2) return;
  const n = size - 2;
  const oam = c.oamExtNext;
  let count = 0;
  for (let side = 0; side < 2; side++)
    picks(c, side, n).forEach((pick, k) => {
      const e = 2 * k + side;
      const cursor = pick >= 0 ? pick : joined(c, e) ? playerCursor(c, e) : -1;
      if (cursor < 0) return;
      const ch = cursorCharacter(c, cursor);
      if (c.wram[SHOWN + e] !== ch + 1) load(c, e, ch);
      const x0 = side === 0 ? -c.wide + ((c.wide - WIDTH) >> 1) : 256 + ((c.wide - WIDTH) >> 1);
      const t0 = firstTile(e);
      for (let by = 0; by < ROWS / 2; by++)
        for (let bx = 0; bx < COLS / 2; bx++) {
          const i = count++;
          const x = x0 + 16 * bx;
          const name = t0 + 32 * by + 2 * bx;
          oam[4 * i] = x & 0xff;
          oam[4 * i + 1] = TOP[k]! + 16 * by;
          oam[4 * i + 2] = name & 0xff;
          oam[4 * i + 3] = PRIORITY | ((PALETTE0 + e) << 1) | (name >> 8);
          const hi = 0x200 + (i >> 2);
          const sh = 2 * (i & 3);
          oam[hi] = (oam[hi]! & ~(3 << sh)) | ((((x >> 8) & 1) | 2) << sh);
          c.oamxNext[SECOND_OAM + i] = FLAGS;
          c.oamWideXNext[SECOND_OAM + i] = x;
        }
    });
  c.oamExtCountNext = count;
}
