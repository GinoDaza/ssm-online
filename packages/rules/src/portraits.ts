/**
 * The extras' portraits in 3 VS 3 and 4 VS 4, in the margins of the team screens that show the
 * four wrestlers of the original as portraits, each extra on its side's side (side 0 left):
 *
 * - the team player select: each picked extra, and the character under a player 5-8's cursor
 *   while they pick, as the original's (8 columns), the side's first extra level with the
 *   upper portraits, the second with the lower ones; their names are BG3 (menus.ts);
 * - the team VS screen: every extra, the CPU's too (the characters the match will give them,
 *   teams.ts), whole (10 columns), one above the other in the margin, beside the original's;
 *   their labels and names are BG3 (menus.ts).
 *
 * The original's portraits (ssm-disasm notes, Code-selected palettes and portraits): C04244 maps
 * a character's 10 x 10 tile map (u24 pointers C0:A307, the first ten), on the player select
 * only its columns 1-8 (flag bit 7), mirrored on side 1 (bit 6, H-flip); the tiles are WRAM list
 * 14 + character (C043FE), the colours C043A5's: 16 from the character's block in bank CB (word
 * pointers C0:A2EF) at the team offset of the slot, C0:A303[slot]. Their layers cannot hold more
 * (BG1's map shows its own other side in the margins; the VS screen's lower portraits are
 * sprites already), so here they are sprites: 16 x 16 pieces (OBSEL 3: 8 / 16) in the second OAM
 * (oamext.ts: drawn below the OAM's), with their real x in the margins, taking their tiles from
 * sprite bank 2 (unused before a match, which loads its own) and their colours from bank 2's
 * palettes 4-7 (EXT.PALETTES, which are bank 2's in team play, sprites.ts). Extra e mirrors slot
 * e (its colours in a match, sprites.ts), so its portrait has slot e's team colours. Its pieces
 * are blocks 25 e .. of bank 2 (8 blocks of 2 x 2 tiles a row of 16 tiles), mirrored there on
 * side 1.
 */
import { OBJX_BANK2, type Machine } from '@ssm/core';
import { chosenTeamSize } from './menu.ts';
import { Screen, screenOf } from './menus.ts';
import { playerCursor } from './players.ts';
import { cursorCharacter, picks } from './select.ts';
import { EXT } from './slots.ts';
import { WRAM_LISTS, vramList } from './sprites.ts';
import { extraChars } from './teams.ts';

const MAPS = 0xc0a307;
const PALETTE_POINTERS = 0xc0a2ef;
const TEAM_ROWS = 0xc0a303;
const PORTRAIT_LIST = 14;
const MAP_COLS = 10;
const ROWS = 10;
/** 16 x 16 blocks of a whole portrait, the first block of extra e's */
const BLOCKS = 25;
/** what portrait e's bank-2 tiles show: character + 1 (0 = nothing yet), WHOLE when whole */
export const SHOWN = 0x6300;
const WHOLE = 0x80;
/** OAM attributes: priority 3, bank 2's palettes 4-7 */
const PRIORITY = 0x30;
const PALETTE0 = 4;
/** Machine.oamx: bank 2 (bit 2), a real x (bit 1) */
const FLAGS = 4 | 2;
const SECOND_OAM = 128;
const TEAM_FLAG = 0x1ba0;
const TEAM_BIT = 0x40;
const PALETTES_DIRTY = 0xd5;
const CURSORS = 0x1b86;

/** the player select's portraits: BG1 rows 3-12 and 13-22, 8 columns */
const SELECT_TOP = [24, 104] as const;
/** the VS screen's: the margin's height above the name boxes (BG2 row 23), 10 columns */
export const VS_TOP = [24, 104] as const;

const rev = (b: number) => {
  let r = 0;
  for (let k = 0; k < 8; k++) r |= ((b >> k) & 1) << (7 - k);
  return r;
};

/** The sprite name of block b (bank 2). */
const blockName = (b: number) => (b >> 3) * 32 + (b & 7) * 2;

/** Portrait e (side e & 1) of character `ch`, `cols` columns (8: from column 1), into bank 2. */
function load(c: Machine, e: number, ch: number, cols: number): void {
  const tiles = vramList(c, PORTRAIT_LIST + ch, WRAM_LISTS)[0]!.data;
  const rom = c.rom;
  const map = rom.u8(MAPS + 3 * ch) | (rom.u8(MAPS + 3 * ch + 1) << 8) | (rom.u8(MAPS + 3 * ch + 2) << 16);
  const mirror = (e & 1) === 1;
  const first = (MAP_COLS - cols) >> 1;
  for (let r = 0; r < ROWS; r++)
    for (let k = 0; k < cols; k++) {
      const src = 32 * rom.u8(map + MAP_COLS * r + first + (mirror ? cols - 1 - k : k));
      const b = BLOCKS * e + (r >> 1) * (cols >> 1) + (k >> 1);
      const dst = OBJX_BANK2 + 32 * (blockName(b) + 16 * (r & 1) + (k & 1));
      for (let i = 0; i < 32; i++) {
        const v = tiles[src + i] ?? 0;
        c.objx[dst + i] = mirror ? rev(v) : v;
      }
    }
  const colours = 0xcb0000 | rom.u8(PALETTE_POINTERS + 2 * ch) | (rom.u8(PALETTE_POINTERS + 2 * ch + 1) << 8);
  const at = colours + rom.u8(TEAM_ROWS + e);
  for (let i = 0; i < 32; i++) c.wram[EXT.PALETTES + 32 * e + i] = rom.u8(at + i);
  c.wram[PALETTES_DIRTY] = 1;
}

/** The selection starts: no portrait loaded (bank 2 may hold a match's tiles). */
export function resetPortraits(c: Machine): void {
  c.wram.fill(0, SHOWN, SHOWN + 4);
}

const teamScreen = (c: Machine) => (c.wram[TEAM_FLAG]! & TEAM_BIT) !== 0 && c.wide !== 0;

/** The extras' characters on the VS screen: the match's (teams.ts), from the selection's four. */
export function vsCharacters(c: Machine): number[] {
  return extraChars(c, [0, 1, 2, 3].map((s) => cursorCharacter(c, c.wram[CURSORS + s]!)));
}

/** At the OBJ pass tail outside big matches (oamext.ts): the extras' portraits, second OAM. */
export function portraitSprites(c: Machine): void {
  const screen = screenOf(c);
  if ((screen !== Screen.TEAM_SELECT && screen !== Screen.VS) || !teamScreen(c)) return;
  const size = chosenTeamSize(c);
  if (size <= 2) return;
  const n = size - 2;
  const vs = screen === Screen.VS;
  const cols = vs ? MAP_COLS : 8;
  const width = 8 * cols;
  const oam = c.oamExtNext;
  let count = 0;
  const shown = vs ? vsCharacters(c) : [];
  for (let e = 0; e < 2 * n; e++) {
    const side = e & 1;
    const k = e >> 1;
    let ch = -1;
    if (vs) ch = shown[e]!;
    else {
      const pick = picks(c, side, n)[k]!;
      const cursor = pick >= 0 ? pick : playerCursor(c, e);
      if (cursor >= 0) ch = cursorCharacter(c, cursor);
    }
    if (ch < 0) continue;
    const key = (ch + 1) | (vs ? WHOLE : 0);
    if (c.wram[SHOWN + e] !== key) {
      load(c, e, ch, cols);
      c.wram[SHOWN + e] = key;
    }
    // the select: in the margin's middle; the VS screen: against the picture's edge
    const x0 = vs
      ? side === 0 ? -c.wide : 256 + c.wide - width
      : side === 0 ? -c.wide + ((c.wide - width) >> 1) : 256 + ((c.wide - width) >> 1);
    const y0 = (vs ? VS_TOP : SELECT_TOP)[k]!;
    for (let by = 0; by < ROWS / 2; by++)
      for (let bx = 0; bx < cols / 2; bx++) {
        const i = count++;
        const x = x0 + 16 * bx;
        const name = blockName(BLOCKS * e + by * (cols >> 1) + bx);
        oam[4 * i] = x & 0xff;
        oam[4 * i + 1] = y0 + 16 * by;
        oam[4 * i + 2] = name & 0xff;
        oam[4 * i + 3] = PRIORITY | ((PALETTE0 + e) << 1) | (name >> 8);
        const hi = 0x200 + (i >> 2);
        const sh = 2 * (i & 3);
        oam[hi] = (oam[hi]! & ~(3 << sh)) | ((((x >> 8) & 1) | 2) << sh);
        c.oamxNext[SECOND_OAM + i] = FLAGS;
        c.oamWideXNext[SECOND_OAM + i] = x;
      }
  }
  c.oamExtCountNext = count;
}

/**
 * After C00369 clears Machine.oamxNext (sprites.ts, once a frame outside a match): the frames the
 * game spends without an OBJ pass (the partner's portrait being loaded) still upload the OAM, so
 * the portraits' pieces keep their flags.
 */
export function keepPortraitFlags(c: Machine): void {
  c.oamxNext.fill(FLAGS, SECOND_OAM, SECOND_OAM + c.oamExtCountNext);
}
