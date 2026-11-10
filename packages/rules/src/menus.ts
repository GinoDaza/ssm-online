/**
 * The menus in the wide picture (Ruleset.wideMenus): the screens before and between matches
 * fill the same 400 x 224 picture as the matches. Their maps end at the SNES screen's 256
 * columns (what lies beyond is another layer's map, or nothing), so each screen says what its
 * margins show (Machine.margins): per layer nothing, or a patch of it repeated; sprites stay
 * inside the 256 (the game parks the unused ones just outside).
 *
 * The screen is known by the last VRAM list loaded (C00643, Y = list * 2; ssm-disasm notes,
 * Screens): 2 the title, 7 the Game Mode Select, 6 the Team Battle Royal entry (ENTER THE
 * MATCH!). Other screens keep the SNES picture between black sides.
 *
 * The entry screen of a 3 VS 3 or 4 VS 4 (the Game Mode Select's choice, menu.ts) shows the
 * extra players' boxes too, in the HUD panels (Machine.hudx) of the margins: the original's
 * four 8 x 11 tile boxes (BG3 rows 17-27, one a player in palettes 0-3: 1P orange, 2P blue,
 * 3P yellow, 4P green) get 5P left and 6P right of them, 7P and 8P above those (rows 5-15),
 * in the panels' own palettes. Their inside is the inside of an original box still waiting for
 * its player (`$1BA6`[pad] = 0; PRESS START, blinking as it does).
 */
import { HUDX_COLS, HUDX_ROWS, MARGIN_SPRITES, MARGIN_WORDS, Margin, type Machine, type Runner } from '@ssm/core';
import { chosenTeamSize } from './menu.ts';

const LOAD_LIST = 0xc00643;
/** rulesWord bits 16-23: the last VRAM list loaded */
const SCREEN_SHIFT = 16;
const SCREEN_MASK = 0xff << SCREEN_SHIFT;
/** VRAM lists shared by several screens (fonts, common tiles): not a screen's own */
const SHARED = new Set([0, 34]);

export const Screen = { TITLE: 2, ENTRY: 6, MODE_SELECT: 7 } as const;

/** The last screen's VRAM list. */
export const screenOf = (c: Machine) => (c.rulesWord & SCREEN_MASK) >>> SCREEN_SHIFT;

interface Patch {
  x: number;
  w: number;
  y: number;
  h: number;
}
/** a layer's margins: off, or a patch of it repeated */
type LayerMargin = 'off' | Patch;

interface ScreenMargins {
  bg1: LayerMargin;
  bg2: LayerMargin;
}

const SCREENS: Record<number, ScreenMargins> = {
  // the logo and the text on the backdrop
  [Screen.TITLE]: { bg1: 'off', bg2: 'off' },
  // the panels (BG1) in the middle; the wallpaper (BG2) repeats every 6 columns and 4 rows
  [Screen.MODE_SELECT]: { bg1: 'off', bg2: { x: 0, w: 48, y: 0, h: 32 } },
  // the lights and ropes (BG1) and the crowd (BG2)
  [Screen.ENTRY]: { bg1: { x: 0, w: 64, y: 0, h: 224 }, bg2: { x: 0, w: 64, y: 0, h: 224 } },
};

function setLayer(c: Machine, n: number, m: LayerMargin): void {
  const k = MARGIN_WORDS * n;
  const w = c.margins;
  if (m === 'off') {
    w[k] = Margin.OFF;
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
  const s = SCREENS[screenOf(c)];
  if (!s) {
    c.wide = 0;
    return;
  }
  c.wide = margin;
  setLayer(c, 0, s.bg1);
  setLayer(c, 1, s.bg2);
  c.margins[MARGIN_SPRITES] = 1;
  if (screenOf(c) === Screen.ENTRY && chosenTeamSize(c) > 2) extraBoxes(c, 2 * (chosenTeamSize(c) - 2));
}

/** the original boxes: BG3 rows BOX_TOP .. + BOX_ROWS, BOX_COLS columns each from column 0 */
const BOX_TOP = 17;
const BOX_ROWS = 11;
const BOX_COLS = 8;
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

/** The boxes of the extra players 5P .. 4 + n. */
function extraBoxes(c: Machine, n: number): void {
  const w = c.wram;
  const map = (c.ioreg[0x09]! & 0xfc) << 9;
  const bg3 = (row: number, col: number) => c.vram[map + 2 * (row * 32 + col)]! | (c.vram[map + 2 * (row * 32 + col) + 1]! << 8);
  // the inside of a box still waiting for its player
  let waiting = -1;
  for (let k = 0; k < 4; k++) if (w[ENTRY_STATE + k] === 0) waiting = k;
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
    put(0, 3, (DIGIT0 + 5 + e) | pal);
    put(0, 4, LETTER_P | pal);
    for (let row = 1; row < BOX_ROWS - 1; row++) {
      put(row, 0, SIDE | pal);
      put(row, BOX_COLS - 1, SIDE | H_FLIP | pal);
      if (waiting < 0) continue;
      for (let col = 1; col < BOX_COLS - 1; col++) {
        const v = bg3(BOX_TOP + row, BOX_COLS * waiting + col);
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
