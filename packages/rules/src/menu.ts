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
 * Here BG1 gets four panels in a row, each a window of a picture (and BG2 the same window of
 * its backdrop, the wallpaper around them): the singles one for 1 VS 1, the team one for the
 * rest, with the game's font (BG1 tiles 100 + character - 20, palette 1) for the labels in
 * row 18. On the SNES screen the panels are 7 tiles wide (a 5 x 10 window, centred); in the
 * wide picture (Ruleset.wideMenus) they take its whole width, 12 tiles each in 400 px (a
 * 10 x 10 window: four whole 14-tile panels would need 56 columns of the 50), drawn past the
 * SNES screen in the second half of the 64-column BG1 / BG2 maps (empty on this screen, and
 * cleared with the rest by the NMI when the next screen comes, C0029A), which the margins
 * show as they go on (menus.ts); the wallpaper fills the rest of BG2's. The choice (0-3)
 * lives in Machine.rulesWord; `$1BA0` bit 6 is set for 2 VS 2 and up, so the game goes on
 * as a Team Battle Royal (3 VS 3 and 4 VS 4 add the extra wrestlers at the match start,
 * teams.ts). The chosen panel shows in colour with a red frame, the others grey. Both lists
 * load the same palettes: the colour picture (CB:CE00) and red frame in the chosen side's
 * pair, the game's one grey (CB:CE40) and grey frame in the other's. So the singles panel
 * keeps palettes 2 / 3, and a team panel takes palettes 4 / 5 when chosen or singles is
 * (both grey then), else 2 / 3 (grey): every grey panel is the game's grey whatever the
 * choice. A press between 1 VS 1 and 2 VS 2 changes the list a frame after the team bit, so
 * the panels follow the list loaded (which pair is grey), not the bit: else that frame shows
 * the new map in the old colours, a flash of 3 VS 3 and 4 VS 4. The titles go, and the
 * countdown (objects 2E) moves down below the labels.
 *
 * A session may preset the choice (seats.ts: the lobby's team size), shown first.
 *
 * With three or four humans the original skips the choice (C030CC: `$1BA4` >= 3 goes to
 * C0313C, which sets team play, shows a message and goes on after a wait). Here the choice
 * runs as for one or two (C030D3: the countdown, pad 1's left / right and confirm), from
 * 2 VS 2 and without 1 VS 1, so three or four humans can play 3 VS 3 or 4 VS 4.
 */
import type { Machine, Runner } from '@ssm/core';
import { resetPlayers } from './players.ts';
import { presetOf } from './seats.ts';

/** rulesWord: the choice 0-3 (1 VS 1 .. 4 VS 4) */
const CHOICE = 3;
/** rulesWord: BG1 has the four panels (cleared when the screen is set up) */
const BUILT = 4;

const TEAM_FLAG = 0x1ba0;
const TEAM_BIT = 0x40;
const HUMANS = 0x1ba4;
const PAD_RIGHT = 0x0100;
const PAD_LEFT = 0x0200;

const TOP = 6;
const BOTTOM = 17;
const LABEL_ROW = 18;
/** the original pictures' first column (singles, team) and width */
const PICTURES = [3, 17];
const PICTURE_WIDTH = 12;
const LABELS = ['1 VS 1', '2 VS 2', '3 VS 3', '4 VS 4'];
const TIMER_Y = 0xa4;
/** the game's CGRAM copy in WRAM (C00E47 fills it, C00295 sends it) */
const PALETTES = 0x3000;
/** BG2 rows below the panels, with the wallpaper that repeats every 4 rows and 6 columns */
const WALLPAPER_ROW = 18;
const WALLPAPER_COLS = 6;

/** Where the panels go: their first columns (negative: the left margin), width, the margins' */
interface Layout {
  cols: number[];
  width: number;
  side: number;
}

/** Four panels across the SNES screen and `side` margin columns each side, as wide as fit. */
function layoutOf(side: number): Layout {
  const span = 32 + 2 * side;
  const width = Math.min(PICTURE_WIDTH + 2, (span - 2) >> 2);
  const first = -side + ((span - 4 * width) >> 1);
  return { cols: [0, 1, 2, 3].map((k) => first + k * width), width, side };
}

/** The team size of the mode chosen on the Game Mode Select (1 = singles). */
export const chosenTeamSize = (c: Machine) => (c.rulesWord & CHOICE) + 1;

/** a map entry's address; columns 32-63 (and negative ones, from 64) in the second half */
const mapAddr = (c: Machine, bg: number, row: number, col: number) => {
  const m = col & 63;
  return ((c.ioreg[0x07 + bg]! & 0xfc) << 9) + ((m >> 5) << 11) + (row * 32 + (m & 31)) * 2;
};
const mod = (a: number, n: number) => ((a % n) + n) % n;
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

/** The frame tiles of a panel at `col`, `width` wide (palette `pal`). */
function frame(c: Machine, col: number, width: number, pal: number): void {
  const p = pal << 10;
  const right = col + width - 1;
  put(c, 0, TOP, col, p | 0x300);
  put(c, 0, TOP, right, p | 0x4300);
  put(c, 0, BOTTOM, col, p | 0x8300);
  put(c, 0, BOTTOM, right, p | 0xc300);
  for (let k = col + 1; k < right; k++) {
    put(c, 0, TOP, k, p | 0x831e);
    put(c, 0, BOTTOM, k, p | 0x31e);
  }
  for (let row = TOP + 1; row < BOTTOM; row++) {
    put(c, 0, row, col, p | 0x430e);
    put(c, 0, row, right, p | 0x30e);
  }
}

/** Replace the two original panels with the four (BG1 as C02FFB left it). */
function build(c: Machine, l: Layout): void {
  const rows = (bg: number) => Array.from({ length: BOTTOM - TOP + 1 }, (_, i) => Array.from({ length: 32 }, (_, col) => get(c, bg, TOP + i, col)));
  const picture = rows(0);
  const backdrop = rows(1);
  const wallpaper = (row: number, col: number) => get(c, 1, WALLPAPER_ROW + mod(row - WALLPAPER_ROW, 4), col);
  const margins = Array.from({ length: 2 * l.side }, (_, k) => (k < l.side ? k - l.side : 32 + k - l.side));
  for (const col of margins) for (let row = 0; row < 32; row++) put(c, 1, row, col, wallpaper(row, mod(col, WALLPAPER_COLS)));
  for (let row = TOP; row <= BOTTOM; row++) for (let col = 0; col < 32; col++) put(c, 1, row, col, wallpaper(row, col));
  for (let row = TOP; row <= LABEL_ROW; row++) for (let col = -l.side; col < 32 + l.side; col++) put(c, 0, row, col, 0);
  const inner = l.width - 2;
  l.cols.forEach((col, k) => {
    const from = PICTURES[k ? 1 : 0]! + ((PICTURE_WIDTH - inner) >> 1);
    for (let row = TOP + 1; row < BOTTOM; row++)
      for (let x = 0; x < inner; x++) {
        put(c, 0, row, col + 1 + x, picture[row - TOP]![from + x]!);
        put(c, 1, row, col + 1 + x, backdrop[row - TOP]![from + x]!);
      }
    const label = col + ((l.width - 5) >> 1);
    for (let i = 0; i < 6; i++) put(c, 0, LABEL_ROW, label + i, 0x2500 + LABELS[k]!.charCodeAt(i) - 0x20);
  });
}

/** Each frame, after C00E47 loaded the palette list: the panels, palettes, titles, countdown. */
function draw(c: Machine, l: Layout): void {
  // the screen comes up on the session's team size (the lobby's, seats.ts)
  if (!(c.rulesWord & BUILT) && presetOf(c)) choose(c, Math.min(3, presetOf(c) - 1));
  const team = (c.wram[TEAM_FLAG]! & TEAM_BIT) !== 0;
  let choice = c.rulesWord & CHOICE;
  if (!team) choice = 0;
  else if (choice === 0) choice = 1; // three or four humans: the game picks the team itself
  c.rulesWord = (c.rulesWord & ~CHOICE) | choice;
  if (!(c.rulesWord & BUILT)) {
    build(c, l);
    c.rulesWord |= BUILT;
  }
  // the list loaded: the team pair in colour (palette 2 grey; still 2 VS 2 the frame back to
  // 1 VS 1), or the singles one (still 1 VS 1 the frame to 2 VS 2)
  const lit = grey(c, 2) ? Math.max(1, choice) : 0;
  l.cols.forEach((col, k) => {
    // the picture's palette, the frame's (and the backdrop's) the next
    const pal = k > 0 && (k === lit || lit === 0) ? 4 : 2;
    frame(c, col, l.width, pal + 1);
    for (let row = TOP + 1; row < BOTTOM; row++)
      for (let x = 1; x < l.width - 1; x++) {
        put(c, 0, row, col + x, withPalette(get(c, 0, row, col + x), pal));
        put(c, 1, row, col + x, withPalette(get(c, 1, row, col + x), pal + 1));
      }
  });
  for (let row = 10; row <= 13; row++) for (let col = 0; col < 32; col++) put(c, 2, row, col, 0);
  for (let d = 0x1200; d < 0x1a00; d += 0x40) if (c.wram[d] !== 0 && c.wram[d + 1] === 0x2e) c.wram[d + 9] = TIMER_Y;
}

/** Whether palette `n` (in the WRAM copy) is all grey. */
function grey(c: Machine, n: number): boolean {
  for (let i = 1; i < 16; i++) {
    const at = PALETTES + 2 * (16 * n + i);
    const v = c.wram[at]! | (c.wram[at + 1]! << 8);
    if ((v & 31) !== ((v >> 5) & 31) || (v & 31) !== ((v >> 10) & 31)) return false;
  }
  return true;
}

/** Whether this Game Mode Select has its four panels (the margins show them, menus.ts). */
export const panelsBuilt = (c: Machine) => (c.rulesWord & BUILT) !== 0;

function choose(c: Machine, choice: number): void {
  c.rulesWord = (c.rulesWord & ~CHOICE) | choice;
  if (choice > 0) c.wram[TEAM_FLAG]! |= TEAM_BIT;
  else c.wram[TEAM_FLAG]! &= ~TEAM_BIT;
}

/** `side`: the wide picture's margin columns each side the panels may take (0: none). */
export function installMenu(r: Runner, side = 0): void {
  const layout = layoutOf(side);
  // C01DE8 (state 02): the screen is set up anew (C02FFB loads the original panels)
  r.split(0xc01dea);
  r.override(0xc01de8, (c) => {
    c.rulesWord &= ~BUILT;
    resetPlayers(c);
    return r.original(c, 0xc01de8);
  });
  // C030CC LDA $1BA4 / CMP #$03 / BCS C0313C: three or four humans choose too, a team mode
  r.split(0xc030d3);
  r.override(0xc030cc, (c) => {
    if (c.wram[HUMANS]! < 3) return r.original(c, 0xc030cc);
    c.tick(4 * c.fast + 8);
    if ((c.rulesWord & CHOICE) === 0) choose(c, 1);
    return 0xc030d3;
  });
  // C03118 LDA / EOR #$40 / STA $1BA0 (a new left or right press, A = the pad word): move
  r.split(0xc03120);
  r.override(0xc03118, (c) => {
    c.tick(8 * c.fast);
    const choice = c.rulesWord & CHOICE;
    const lowest = c.wram[HUMANS]! >= 3 ? 1 : 0;
    if (c.a & PAD_RIGHT) choose(c, Math.min(3, choice + 1));
    else if (c.a & PAD_LEFT) choose(c, Math.max(lowest, choice - 1));
    return 0xc03120;
  });
  // C03131, after JSR C00E47 (the palette list): draw
  r.split(0xc03133);
  r.override(0xc03131, (c) => {
    c.tick(200 * c.fast);
    draw(c, layout);
    return r.original(c, 0xc03131);
  });
}
