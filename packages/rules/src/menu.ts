/**
 * The Game Mode Select with four choices (Ruleset.modeMenu): 1 VS 1, 2 VS 2, 3 VS 3, 4 VS 4,
 * in a row, instead of the original's two panels (SINGLE MATCH, TEAM BATTLE ROYAL).
 *
 * The original screen (set up by C02FFB from state 02, C01DE8; ticked by C030BC in state 04):
 * BG1 holds two 14 x 12 tile panels at columns 2-15 and 16-29, rows 6-17 (a frame of tiles
 * 300 / 30E / 31E with flips around a 12 x 10 picture: singles in palette 2, frame palette 3;
 * team in palette 4, frame palette 5). Behind each picture BG2 has its backdrop (stars, ropes,
 * crowd; tiles shared by both, in the frame's palette), elsewhere the wallpaper (a pattern
 * that repeats every 4 rows). BG3 has the panels' orange titles (rows 10-13). Left / right
 * (C03111: new presses 0300) toggle `$1BA0` bit 6 (team), and every frame C03128 loads the
 * palette list 0E (singles chosen: palettes 2 / 3 in colour and red, 4 / 5 grey) or 10 (team
 * chosen: the other way round) through C00E47.
 *
 * Here BG1 gets four 7 x 12 panels at columns 2, 9, 16 and 23, each a 5 x 10 window of a
 * picture (and BG2 the same window of its backdrop, the wallpaper around them): the singles one for 1 VS 1, three windows of the team one for the rest, with the
 * game's font (BG1 tiles 100 + character - 20, palette 1) for the labels in row 18. The
 * choice (0-3) lives in Machine.rulesWord; `$1BA0` bit 6 is set for 2 VS 2 and up, so the
 * game goes on as a Team Battle Royal (3 VS 3 and 4 VS 4 play as 2 VS 2 for now). The chosen
 * panel shows in colour with a red frame, the others grey: the singles panel keeps palettes
 * 2 / 3 (the list makes them right), a team panel takes palettes 4 / 5 when chosen, else
 * palette 6 (free on this screen: palette 4 made grey) with the list's grey frame. The
 * titles go, and the countdown (objects 2E) moves down below the labels.
 */
import type { Machine, Runner } from '@ssm/core';

/** rulesWord: the choice 0-3 (1 VS 1 .. 4 VS 4) */
const CHOICE = 3;
/** rulesWord: BG1 has the four panels (cleared when the screen is set up) */
const BUILT = 4;

const TEAM_FLAG = 0x1ba0;
const TEAM_BIT = 0x40;
const PAD_RIGHT = 0x0100;
const PAD_LEFT = 0x0200;

const PALETTES = 0x3000; // the game's CGRAM copy in WRAM
const GREY_TEAM = 6;

const COLS = [2, 9, 16, 23];
const TOP = 6;
const BOTTOM = 17;
const LABEL_ROW = 18;
/** the original pictures' first column, and each panel's window into it */
const SOURCE = [6, 17, 20, 23];
const LABELS = ['1 VS 1', '2 VS 2', '3 VS 3', '4 VS 4'];
const TIMER_Y = 0xa4;
/** BG2 rows below the panels, with the wallpaper that repeats every 4 rows */
const WALLPAPER_ROW = 18;

/** The team size of the mode chosen on the Game Mode Select (1 = singles). */
export const chosenTeamSize = (c: Machine) => (c.rulesWord & CHOICE) + 1;

const mapAddr = (c: Machine, bg: number, row: number, col: number) => ((c.ioreg[0x07 + bg]! & 0xfc) << 9) + (row * 32 + col) * 2;
const get = (c: Machine, bg: number, row: number, col: number) => {
  const a = mapAddr(c, bg, row, col);
  return c.vram[a]! | (c.vram[a + 1]! << 8);
};
const put = (c: Machine, bg: number, row: number, col: number, v: number) => {
  const a = mapAddr(c, bg, row, col);
  c.vram[a] = v & 0xff;
  c.vram[a + 1] = v >> 8;
};
const withPalette = (e: number, pal: number) => (e & ~0x1c00) | (pal << 10);

/** The frame tiles of a panel at `col` (palette `pal`). */
function frame(c: Machine, col: number, pal: number): void {
  const p = pal << 10;
  put(c, 0, TOP, col, p | 0x300);
  put(c, 0, TOP, col + 6, p | 0x4300);
  put(c, 0, BOTTOM, col, p | 0x8300);
  put(c, 0, BOTTOM, col + 6, p | 0xc300);
  for (let k = 1; k < 6; k++) {
    put(c, 0, TOP, col + k, p | 0x831e);
    put(c, 0, BOTTOM, col + k, p | 0x31e);
  }
  for (let row = TOP + 1; row < BOTTOM; row++) {
    put(c, 0, row, col, p | 0x430e);
    put(c, 0, row, col + 6, p | 0x30e);
  }
}

/** Replace the two original panels with the four (BG1 as C02FFB left it). */
function build(c: Machine): void {
  const rows = (bg: number) => Array.from({ length: BOTTOM - TOP + 1 }, (_, i) => Array.from({ length: 32 }, (_, col) => get(c, bg, TOP + i, col)));
  const picture = rows(0);
  const backdrop = rows(1);
  for (let row = TOP; row <= LABEL_ROW; row++) for (let col = 0; col < 32; col++) put(c, 0, row, col, 0);
  for (let row = TOP; row <= BOTTOM; row++)
    for (let col = 0; col < 32; col++) put(c, 1, row, col, get(c, 1, WALLPAPER_ROW + ((((row - WALLPAPER_ROW) % 4) + 4) % 4), col));
  COLS.forEach((col, k) => {
    for (let row = TOP + 1; row < BOTTOM; row++)
      for (let x = 0; x < 5; x++) {
        put(c, 0, row, col + 1 + x, picture[row - TOP]![SOURCE[k]! + x]!);
        put(c, 1, row, col + 1 + x, backdrop[row - TOP]![SOURCE[k]! + x]!);
      }
    for (let i = 0; i < 6; i++) put(c, 0, LABEL_ROW, col + 1 + i, 0x2500 + LABELS[k]!.charCodeAt(i) - 0x20);
  });
}

/** Palette 6 = palette 4 in grey (BGR555; colour 0 kept). */
function greyTeam(c: Machine): void {
  const w = c.wram;
  for (let i = 0; i < 16; i++) {
    const at = PALETTES + 2 * (4 * 16 + i);
    const v = w[at]! | (w[at + 1]! << 8);
    let g = v;
    if (i !== 0) {
      const l = (77 * (v & 31) + 151 * ((v >> 5) & 31) + 28 * ((v >> 10) & 31)) >> 8;
      g = l | (l << 5) | (l << 10);
    }
    const to = PALETTES + 2 * (GREY_TEAM * 16 + i);
    w[to] = g & 0xff;
    w[to + 1] = g >> 8;
  }
}

/** Each frame, after C00E47 loaded the palette list: the panels, palettes, titles, countdown. */
function draw(c: Machine): void {
  const team = (c.wram[TEAM_FLAG]! & TEAM_BIT) !== 0;
  let choice = c.rulesWord & CHOICE;
  if (!team) choice = 0;
  else if (choice === 0) choice = 1; // three or four humans: the game picks the team itself
  c.rulesWord = (c.rulesWord & ~CHOICE) | choice;
  if (!(c.rulesWord & BUILT)) {
    build(c);
    c.rulesWord |= BUILT;
  }
  frame(c, COLS[0]!, 3);
  for (let row = TOP + 1; row < BOTTOM; row++) for (let x = 1; x < 6; x++) put(c, 1, row, COLS[0]! + x, withPalette(get(c, 1, row, COLS[0]! + x), 3));
  for (let k = 1; k < 4; k++) {
    const col = COLS[k]!;
    const chosen = k === choice;
    const framePal = chosen ? 5 : team ? 3 : 5;
    frame(c, col, framePal);
    for (let row = TOP + 1; row < BOTTOM; row++)
      for (let x = 1; x < 6; x++) {
        put(c, 0, row, col + x, withPalette(get(c, 0, row, col + x), chosen ? 4 : GREY_TEAM));
        put(c, 1, row, col + x, withPalette(get(c, 1, row, col + x), framePal));
      }
  }
  greyTeam(c);
  for (let row = 10; row <= 13; row++) for (let col = 0; col < 32; col++) put(c, 2, row, col, 0);
  for (let d = 0x1200; d < 0x1a00; d += 0x40) if (c.wram[d] !== 0 && c.wram[d + 1] === 0x2e) c.wram[d + 9] = TIMER_Y;
}

function choose(c: Machine, choice: number): void {
  c.rulesWord = (c.rulesWord & ~CHOICE) | choice;
  if (choice > 0) c.wram[TEAM_FLAG]! |= TEAM_BIT;
  else c.wram[TEAM_FLAG]! &= ~TEAM_BIT;
}

export function installMenu(r: Runner): void {
  // C01DE8 (state 02): the screen is set up anew (C02FFB loads the original panels)
  r.split(0xc01dea);
  r.override(0xc01de8, (c) => {
    c.rulesWord &= ~BUILT;
    return r.original(c, 0xc01de8);
  });
  // C03118 LDA / EOR #$40 / STA $1BA0 (a new left or right press, A = the pad word): move
  r.split(0xc03120);
  r.override(0xc03118, (c) => {
    c.tick(8 * c.fast);
    const choice = c.rulesWord & CHOICE;
    if (c.a & PAD_RIGHT) choose(c, Math.min(3, choice + 1));
    else if (c.a & PAD_LEFT) choose(c, Math.max(0, choice - 1));
    return 0xc03120;
  });
  // C03131, after JSR C00E47 (the palette list): draw
  r.split(0xc03133);
  r.override(0xc03131, (c) => {
    c.tick(200 * c.fast);
    draw(c);
    return r.original(c, 0xc03131);
  });
}
