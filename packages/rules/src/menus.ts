/**
 * The menus in the wide picture (Ruleset.wideMenus): the screens before and between matches
 * fill the same 400 x 224 picture as the matches. Their maps end at the SNES screen's 256
 * columns (what lies beyond is another layer's map, or nothing), so each screen says what its
 * margins show (Machine.margins): per layer nothing, or a patch of it repeated; sprites stay
 * inside the 256 (the game parks the unused ones just outside).
 *
 * The screen is known by the last VRAM list loaded (C00643, Y = list * 2; ssm-disasm notes,
 * Screens): 7 the Game Mode Select, 6 the Team Battle Royal entry (ENTER THE MATCH!), 3 / 4
 * the player select (single / team). Other screens keep the SNES picture between black sides,
 * the title (2) too: its margins would only show the backdrop colour.
 *
 * The team player select of a 3 VS 3 or 4 VS 4 shows the extras picked so far (select.ts) in
 * the margins, each side's on its side: their portraits (portraits.ts) and, over the portraits'
 * lower edge, their names in the screen's own font (BG3, 8 x 16: two tiles a letter; the names
 * are the game's, the text records at C0:8A37); players 5-8's with their number, the name under
 * their cursor blinking until they pick.
 *
 * The entry screen of a 3 VS 3 or 4 VS 4 (the Game Mode Select's choice, menu.ts) shows the
 * extra players' boxes too, in the HUD panels (Machine.hudx) of the margins: the original's
 * four 8 x 11 tile boxes (BG3 rows 17-27, one a player in palettes 0-3: 1P orange, 2P blue,
 * 3P yellow, 4P green) get 5P left and 6P right of them, 7P and 8P above those (rows 5-15),
 * in the panels' own palettes; all eight are labelled by seat (seats.ts: team by team, P1-P3
 * against P4-P6 in 3 VS 3) instead of by pad. Their inside is the inside of an original box still waiting for
 * its player (`$1BA6`[pad] = 0; PRESS START, blinking as it does), or, once the player joined
 * (players.ts), of one whose player did (ENTRY ACCEPTED).
 */
import { HUDX_COLS, HUDX_ROWS, MARGIN_SPRITES, MARGIN_WORDS, Margin, type Machine, type Runner } from '@ssm/core';
import { chosenTeamSize, panelsBuilt } from './menu.ts';
import { keepPortraitFlags, vsCharacters } from './portraits.ts';
import { cursorCharacter, picks } from './select.ts';
import { joined, playerCursor } from './players.ts';
import { playerNumber } from './seats.ts';

const LOAD_LIST = 0xc00643;
/** rulesWord bits 16-23: the last VRAM list loaded */
const SCREEN_SHIFT = 16;
const SCREEN_MASK = 0xff << SCREEN_SHIFT;
/** VRAM lists shared by several screens (fonts, common tiles): not a screen's own */
const SHARED = new Set([0, 34]);

export const Screen = { TITLE: 2, SELECT: 3, TEAM_SELECT: 4, ENTRY: 6, MODE_SELECT: 7, VS: 8 } as const;

/** The last screen's VRAM list. */
export const screenOf = (c: Machine) => (c.rulesWord & SCREEN_MASK) >>> SCREEN_SHIFT;

interface Patch {
  x: number;
  w: number;
  y: number;
  h: number;
}
/** a layer's margins: its map goes on (with the margins' own tiles), off, or a patch of it repeated */
type LayerMargin = 'map' | 'own' | 'off' | Patch;

interface ScreenMargins {
  bg1: LayerMargin;
  bg2: LayerMargin;
  bg3?: LayerMargin;
}

/**
 * The Game Mode Select with the four panels (menu.ts) across the wide picture: BG1 and BG2
 * go on into their maps' second halves, where they are drawn; BG3's second half is BG1's map.
 */
const WIDE_MODE_SELECT: ScreenMargins = { bg1: 'map', bg2: 'map', bg3: 'off' };

/**
 * The team VS screen (VRAM list 8, also the singles' VS, which keeps the SNES picture): the
 * backdrop (BG2, C046A6: blue and red halves, the name boxes below) goes on into its map's second
 * half (vsBackdrop()); the portraits' layer (BG1) and the text (BG3) stay inside, the extras'
 * portraits and texts are the margins' own (portraits.ts, vsTexts()).
 */
const TEAM_VS: ScreenMargins = { bg1: 'off', bg2: 'map', bg3: 'off' };

const SCREENS: Record<number, ScreenMargins> = {
  // the panels (BG1) in the middle; the wallpaper (BG2) repeats every 6 columns and 4 rows
  [Screen.MODE_SELECT]: { bg1: 'off', bg2: { x: 0, w: 48, y: 0, h: 32 } },
  // the lights and ropes (BG1) and the crowd (BG2)
  [Screen.ENTRY]: { bg1: { x: 0, w: 64, y: 0, h: 224 }, bg2: { x: 0, w: 64, y: 0, h: 224 } },
  // the portraits (BG1) on the backdrop, the belt (BG2) drawn on into the margins (belt())
  [Screen.SELECT]: { bg1: 'off', bg2: 'own' },
  [Screen.TEAM_SELECT]: { bg1: 'off', bg2: 'own' },
};

function setLayer(c: Machine, n: number, m: LayerMargin): void {
  const k = MARGIN_WORDS * n;
  const w = c.margins;
  if (typeof m === 'string') {
    w[k] = m === 'map' ? Margin.MAP : m === 'own' ? Margin.OWN : Margin.OFF;
    return;
  }
  w[k] = Margin.REPEAT;
  w[k + 1] = m.x;
  w[k + 2] = m.w;
  w[k + 3] = m.y;
  w[k + 4] = m.h;
}

/**
 * Once a frame outside a match (sprites.ts, C00369, after the match picture is cleared): the
 * current screen's margins, or the SNES picture.
 */
export function menuPicture(c: Machine, margin: number): void {
  c.margins.fill(0);
  const team = (c.wram[TEAM_FLAG]! & TEAM_BIT) !== 0;
  const s =
    screenOf(c) === Screen.MODE_SELECT && panelsBuilt(c)
      ? WIDE_MODE_SELECT
      : screenOf(c) === Screen.VS
        ? team ? TEAM_VS : undefined
        : SCREENS[screenOf(c)];
  if (!s) {
    c.wide = 0;
    return;
  }
  c.wide = margin;
  setLayer(c, 0, s.bg1);
  setLayer(c, 1, s.bg2);
  if (s.bg3) setLayer(c, 2, s.bg3);
  c.margins[MARGIN_SPRITES] = 1;
  if (screenOf(c) === Screen.SELECT || screenOf(c) === Screen.TEAM_SELECT) belt(c);
  const size = team ? chosenTeamSize(c) : 2;
  if (screenOf(c) === Screen.ENTRY && size > 2) extraBoxes(c, 2 * (size - 2));
  if (screenOf(c) === Screen.TEAM_SELECT && size > 2) {
    pickedNames(c, size - 2);
    keepPortraitFlags(c);
  }
  if (screenOf(c) === Screen.VS) {
    vsBackdrop(c);
    if (size > 2) {
      vsTexts(c, size - 2);
      keepPortraitFlags(c);
    }
  }
}

/**
 * The team VS screen's backdrop (BG2, 64 columns, the second half unused) into the margins: each
 * row's edge entry repeated, the left margin's (map columns 55-63) the row's first, the right
 * margin's (32-40) its last: the blue and red halves, the name boxes at the bottom.
 */
function vsBackdrop(c: Machine): void {
  const base = (c.ioreg[0x08]! & 0xfc) << 9;
  const vram = c.vram;
  const at = (row: number, col: number) => (base + ((col & 32) << 6) + (row * 32 + (col & 31)) * 2) & 0xffff;
  for (let row = 0; row < 32; row++)
    for (const [from, edge] of [
      [64 - MARGIN_COLS, 0],
      [32, 31],
    ] as const) {
      const a = at(row, edge);
      for (let k = 0; k < MARGIN_COLS; k++) {
        const b = at(row, from + k);
        vram[b] = vram[a]!;
        vram[b + 1] = vram[a + 1]!;
      }
    }
}

/** the VS screen's BG3 rows: the extras' labels (their portraits' last two), the names (boxes) */
const VS_LABEL_ROWS = [11, 21];
const VS_NAME_ROWS = [23, 25];

/**
 * The VS screen's texts of the extras, in the screen's font, in the margins' HUD panels (BG3):
 * on each portrait (portraits.ts) its player as the original labels its own, "COM" or a player
 * 5-8's number, at the same place (left: its second column; right: its seventh); in the side's
 * name box, beside the original's two names, theirs as the original writes a pair ("A", "& B").
 */
function vsTexts(c: Machine, n: number): void {
  c.hudxMap.fill(0);
  c.hudxRow = VS_LABEL_ROWS[0]!;
  c.hudxRows = VS_NAME_ROWS[1]! + 2 - VS_LABEL_ROWS[0]!;
  const chars = vsCharacters(c);
  const put = (side: number, row: number, col: number, text: string) =>
    [...text].forEach((ch, i) => {
      const t = glyph(ch);
      if (!t) return;
      panelPut(c, side, row - c.hudxRow, col + i, TEXT | t);
      panelPut(c, side, row + 1 - c.hudxRow, col + i, TEXT | (t + 1));
    });
  for (let e = 0; e < 2 * n; e++) {
    const side = e & 1;
    const k = e >> 1;
    const label = joined(c, e) ? `${playerNumber(n + 2, 4 + e)}P` : 'COM';
    put(side, VS_LABEL_ROWS[k]!, side === 0 ? 1 : 5, label);
    put(side, VS_NAME_ROWS[k]!, k, `${k ? '& ' : ''}${nameOf(c, chars[e]!)}`);
  }
}

/** the belt's BG2 columns: the side medallion's visible part (0-3, its inner side first), the strap */
const MEDALLION_PX = 32;
const STRAP_COL = 4;
/** the medallion's middle, which never shows: its inner pixel column, this many more times */
const STRETCH = 2;
/** the belt's BG2 rows at the screen's edges (the team select's portraits are below) */
const BELT_ROWS = [5, 17];
const MARGIN_COLS = 9;

/**
 * The player select's belt (BG2, mirrored about the middle) goes on into the margins: each side
 * medallion, cut by the screen's edge, is completed by its visible part mirrored, its inner
 * pixel column (the middle, which never shows) widened STRETCH pixels; then the strap to the
 * picture's edge. VRAM has no room for the new tiles on this screen (portraits, sprites), so
 * they are the margins' own (Machine.marginTiles, Margin.OWN), entries in the second half of
 * the 64-column BG2 map (empty here): the right margin's, and the left's mirrored. Redrawn
 * every frame from the screen's own tiles.
 */
function belt(c: Machine): void {
  const base = (c.ioreg[0x08]! & 0xfc) << 9;
  const chr = ((c.ioreg[0x0b]! >> 4) & 15) << 13;
  const vram = c.vram;
  const at = (row: number, col: number) => base + ((col & 32) << 6) + (row * 32 + (col & 31)) * 2;
  const get = (row: number, col: number) => vram[at(row, col)]! | (vram[at(row, col) + 1]! << 8);
  const put = (row: number, col: number, v: number) => {
    vram[at(row, col)] = v & 0xff;
    vram[at(row, col) + 1] = v >> 8;
  };
  /** the colour index (4 bpp) of pixel x, y of map entry e */
  const pixel = (e: number, x: number, y: number) => {
    const t = (chr + (e & 0x3ff) * 32 + 2 * (e & 0x8000 ? 7 - y : y)) & 0xffff;
    const bit = e & 0x4000 ? x : 7 - x;
    return ((vram[t]! >> bit) & 1) | (((vram[t + 1]! >> bit) & 1) << 1) | (((vram[t + 16]! >> bit) & 1) << 2) | (((vram[t + 17]! >> bit) & 1) << 3);
  };
  /** the BG2 column and pixel a right margin pixel shows */
  const source = (x: number): [number, number] => {
    const m = Math.max(0, x - STRETCH);
    return m < MEDALLION_PX ? [m >> 3, m & 7] : [STRAP_COL, (m - MEDALLION_PX) & 7];
  };
  const tiles = c.marginTiles;
  tiles.fill(0, 0, 32); // tile 0: nothing (the entries off the belt)
  let next = 1;
  for (let row = 0; row < 32; row++)
    for (let k = 0; k < MARGIN_COLS; k++) {
      if (row < BELT_ROWS[0]! || row > BELT_ROWS[1]!) {
        put(row, 32 + k, 0);
        put(row, 63 - k, 0);
        continue;
      }
      const t = next++ * 32;
      tiles.fill(0, t, t + 32);
      for (let i = 0; i < 8; i++) {
        const [col, px] = source(8 * k + i);
        const e = get(row, col);
        for (let y = 0; y < 8; y++) {
          const v = pixel(e, px, y);
          for (let p = 0; p < 4; p++) if ((v >> p) & 1) tiles[t + 2 * y + (p & 1) + (p >> 1) * 16]! |= 0x80 >> i;
        }
      }
      // palette and priority of the tile's first source entry (the belt's are all palette 2)
      const entry = (get(row, source(8 * k)[0]) & 0x3c00) | (t >> 5);
      put(row, 32 + k, entry); // the right margin
      put(row, 63 - k, entry | 0x4000); // the left one: mirrored
    }
}

const TEAM_FLAG = 0x1ba0;
const TEAM_BIT = 0x40;
/** the characters' names: text records (length, 20, a word, the letters, 00) by character */
const NAMES = 0xc08a37;
/** the select screen's font (BG3 tiles, the top half; the bottom one is the next tile) */
const FONT_A_TO_G = [0x17, 0x19, 0x1b, 0x23, 0x25, 0x28, 0x2a];
const FONT_H = 0x60;
const FONT_0 = 0x01;
const FONT_AMPERSAND = 0x5d;
/** the game's frame counter (blinks: bit 4) */
const FRAMES = 0x1c8e;
const TEXT = 0x2000;
/**
 * the names' BG3 rows: the lower edge of the extras' portraits (portraits.ts), as the original's
 * names are of theirs (one extra: the first)
 */
const NAME_ROWS = [11, 21];

/** A character's name (ASCII capitals) from the ROM. */
function nameOf(c: Machine, ch: number): string {
  let at = NAMES;
  for (let k = 0; k < ch; k++) at += 5 + c.rom.u8(at);
  let s = '';
  for (let k = 0; k < c.rom.u8(at); k++) s += String.fromCharCode(c.rom.u8(at + 4 + k));
  return s;
}

/** A capital, digit or & top tile in the select screen's font (0: none; the VS screen's too). */
function glyph(ch: string): number {
  if (ch === '&') return FONT_AMPERSAND;
  const d = ch.charCodeAt(0) - 0x30;
  if (d >= 0 && d < 10) return FONT_0 + 2 * d;
  const k = ch.charCodeAt(0) - 0x41;
  if (k < 0 || k >= 26) return 0;
  return k < 7 ? FONT_A_TO_G[k]! : FONT_H + 2 * (k - 7);
}

/** The extras' names picked so far, side 0's in the left panel, side 1's in the right. */
function pickedNames(c: Machine, n: number): void {
  c.hudxMap.fill(0);
  c.hudxRow = NAME_ROWS[0]!;
  c.hudxRows = NAME_ROWS[n - 1]! + 2 - NAME_ROWS[0]!;
  for (let side = 0; side < 2; side++)
    picks(c, side, n).forEach((pick, k) => {
      const e = 2 * k + side;
      const human = joined(c, e);
      const cursor = pick >= 0 ? pick : human ? playerCursor(c, e) : -1;
      if (cursor < 0) return;
      // the name under a cursor blinks; the number stays
      const blink = pick < 0 && (c.wram[FRAMES]! & 0x10) !== 0;
      const label = human ? `${playerNumber(n + 2, 4 + e)}P ` : '';
      const name = label + nameOf(c, cursorCharacter(c, cursor));
      const row = NAME_ROWS[k]! - NAME_ROWS[0]!;
      // from the portrait's second column, as the original's (fewer for players 5-8's long ones)
      const col = Math.max(0, Math.min(1, HUDX_COLS - name.length));
      [...name].forEach((ch, i) => {
        const t = glyph(ch);
        if (!t || (blink && i >= label.length)) return;
        panelPut(c, side, row, col + i, TEXT | t);
        panelPut(c, side, row + 1, col + i, TEXT | (t + 1));
      });
    });
}

/** the original boxes: BG3 rows BOX_TOP .. + BOX_ROWS, BOX_COLS columns each from column 0 */
const BOX_TOP = 17;
const BOX_ROWS = 11;
const BOX_COLS = 8;
/** WRAM the boxes' BG3 rows come from (C032DB's cells), from row BOX_TOP */
const BOX_BUFFER = 0x2000;
/** the panels' rows start at the top boxes' (BG3 row 5), the bottom ones are 12 rows down */
const PANEL_ROW = 5;
const LOW_BOXES = BOX_TOP - PANEL_ROW;
/** box frame tiles (BG3, priority set): corner, top, side, bottom; label digits 30 + n, P */
const CORNER = 0x2301;
const TOP_EDGE = 0x2302;
const SIDE = 0x2300;
const BOTTOM_EDGE = 0x2304;
const H_FLIP = 0x4000;
const V_FLIP = 0x8000;
const DIGIT0 = 0x2030;
const LETTER_P = 0x2050;
/** each pad's entry state (0: waiting for its START) */
const ENTRY_STATE = 0x1ba6;
/** the extra players' colours (BGR555): colour 1 and 3 of their palettes; 2 is the outline */
const EXTRA_COLOURS = [
  [0x5c1f, 0x4016], // 5P pink
  [0x7f80, 0x6280], // 6P cyan
  [0x7d14, 0x588e], // 7P purple
  [0x7fff, 0x5ad6], // 8P white
] as const;
const OUTLINE = 0x3882;

function panelPut(c: Machine, panel: number, row: number, col: number, v: number): void {
  if (row < 0 || row >= HUDX_ROWS || col < 0 || col >= HUDX_COLS) return;
  const a = 2 * ((panel * HUDX_ROWS + row) * HUDX_COLS + col);
  c.hudxMap[a] = v & 0xff;
  c.hudxMap[a + 1] = v >> 8;
}

/** The boxes of the extra players 5P .. 4 + n; every box labelled with its seat's number. */
function extraBoxes(c: Machine, n: number): void {
  const size = n / 2 + 2;
  const w = c.wram;
  const map = (c.ioreg[0x09]! & 0xfc) << 9;
  const bg3 = (row: number, col: number) => c.vram[map + 2 * (row * 32 + col)]! | (c.vram[map + 2 * (row * 32 + col) + 1]! << 8);
  // the inside of a box still waiting for its player, and of one whose player joined
  let waiting = -1;
  let entered = -1;
  for (let k = 0; k < 4; k++) {
    if (w[ENTRY_STATE + k] === 0) waiting = k;
    else if (entered < 0) entered = k;
    // the original box's label digit (row BOX_TOP, column 3 of the box): the pad's seat
    // number. The boxes' rows are DMA'd from a WRAM buffer (BOX_BUFFER: row BOX_TOP first).
    const a = BOX_BUFFER + 2 * (BOX_COLS * k + 3);
    if (w[a]! >= 0x31 && w[a]! <= 0x38) w[a] = (DIGIT0 + playerNumber(size, k)) & 0xff;
  }
  c.hudxMap.fill(0);
  c.hudxRow = PANEL_ROW;
  c.hudxRows = LOW_BOXES + BOX_ROWS;
  c.margins[MARGIN_SPRITES]! |= 2;
  for (let e = 0; e < n; e++) {
    const pal = e << 10;
    const [main, dark] = EXTRA_COLOURS[e]!;
    for (const [i, v] of [0, main, OUTLINE, dark].entries()) {
      c.hudxPalettes[2 * (4 * e + i)] = v & 0xff;
      c.hudxPalettes[2 * (4 * e + i) + 1] = v >> 8;
    }
    const panel = e & 1;
    const top = e < 2 ? LOW_BOXES : 0;
    const left = panel === 0 ? 0 : 1;
    const put = (row: number, col: number, v: number) => panelPut(c, panel, top + row, left + col, v);
    put(0, 0, CORNER | pal);
    put(0, BOX_COLS - 1, CORNER | H_FLIP | pal);
    put(BOX_ROWS - 1, 0, CORNER | V_FLIP | pal);
    put(BOX_ROWS - 1, BOX_COLS - 1, CORNER | H_FLIP | V_FLIP | pal);
    for (let col = 1; col < BOX_COLS - 1; col++) {
      put(0, col, TOP_EDGE | pal);
      put(BOX_ROWS - 1, col, BOTTOM_EDGE | pal);
    }
    put(0, 3, (DIGIT0 + playerNumber(size, 4 + e)) | pal);
    put(0, 4, LETTER_P | pal);
    const inside = joined(c, e) ? entered : waiting;
    for (let row = 1; row < BOX_ROWS - 1; row++) {
      put(row, 0, SIDE | pal);
      put(row, BOX_COLS - 1, SIDE | H_FLIP | pal);
      if (inside < 0) continue;
      for (let col = 1; col < BOX_COLS - 1; col++) {
        const v = bg3(BOX_TOP + row, BOX_COLS * inside + col);
        if (v & 0x3ff) put(row, col, (v & ~0x1c00) | pal);
      }
    }
  }
}

export function installMenus(r: Runner): void {
  r.override(LOAD_LIST, (c) => {
    const list = (c.y & 0xff) >> 1;
    if (!SHARED.has(list)) c.rulesWord = (c.rulesWord & ~SCREEN_MASK) | (list << SCREEN_SHIFT);
    return r.original(c, LOAD_LIST);
  });
}
