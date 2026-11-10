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
 */
import { MARGIN_SPRITES, MARGIN_WORDS, Margin, type Machine, type Runner } from '@ssm/core';

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
}

export function installMenus(r: Runner): void {
  r.override(LOAD_LIST, (c) => {
    const list = (c.y & 0xff) >> 1;
    if (!SHARED.has(list)) c.rulesWord = (c.rulesWord & ~SCREEN_MASK) | (list << SCREEN_SHIFT);
    return r.original(c, LOAD_LIST);
  });
}
