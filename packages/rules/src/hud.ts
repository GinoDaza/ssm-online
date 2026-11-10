/**
 * The HUD of the extra wrestlers in 3 vs 3 and 4 vs 4 (teams.ts). The team HUD (BG3 rows 4-7,
 * ssm-disasm notes, HUD) has four 8-column blocks, two a team, filling the SNES screen's width:
 * face (2 x 2 tiles), life bar (5 cells), tag and name. The extras get theirs in the Machine's
 * HUD panels (Machine.hudx) beside it, in the wide picture's margins: team A's (0800's side,
 * the left blocks) on the left, team B's on the right. A block is two rows: the face with the
 * name, then the face with the life bar (the original's tiles: the band colours of C0607D).
 * One extra a side sits on the faces' rows (5-6); two take rows 4-5 and 6-7.
 *
 * Faces and names: each character's 0x100-byte portrait block (16 2bpp tiles: three faces and
 * the name) is in WRAM at 7E:9000 + character << 8 when the match load copies the four players'
 * (C025C9); the extras' are copied from there to the panels' own tiles. Face choice as C06185:
 * the down face when +BD or +D1 is set, the hurt one when +BC is, else the normal one; the left
 * side's faces are mirrored. The life bar follows C0607D: the shown value (+1DB, unused by the
 * extras otherwise) jumps up to C0:9793[life] and falls one unit a frame (at once when +D1 is
 * set); 5 cells of 8 in three bands of 0x28 (palette bits 1000 / 1400 / 1800).
 */
import { HUDX_COLS, HUDX_ROWS, HUDX_TILE0, type Machine, type Runner } from '@ssm/core';
import { EXTRA, bigTeams, extras } from './slots.ts';

const PORTRAITS = 0x9000;
const LIFE_BARS = 0xc09793;
/** the faces' first tiles in a portrait block: down, hurt, normal (C0:A8D6) */
const FACES = [8, 4, 0] as const;
const H_FLIP = 0x4000;

/** Copy the extras' portrait blocks (the characters `chars`) to the panels' tiles. */
export function loadPortraits(c: Machine, chars: number[]): void {
  chars.forEach((ch, e) => c.hudxTiles.set(c.wram.subarray(PORTRAITS + (ch << 8), PORTRAITS + (ch << 8) + 0x100), e * 0x100));
}

function put(c: Machine, panel: number, row: number, col: number, v: number): void {
  const a = 2 * ((panel * HUDX_ROWS + row) * HUDX_COLS + col);
  c.hudxMap[a] = v & 0xff;
  c.hudxMap[a + 1] = v >> 8;
}

/** The extras' blocks, once a frame. */
function draw(c: Machine): void {
  const w = c.wram;
  const n = extras(c);
  c.hudxMap.fill(0);
  c.hudxRow = 4;
  c.hudxRows = 4;
  for (let e = 0; e < n; e++) {
    const page = EXTRA[e]!;
    const panel = e & 1;
    const row = n === 2 ? 1 : 2 * (e >> 1);
    const col = panel === 0 ? 1 : 0;
    // face
    const face = w[page + 0xbd] || w[page + 0xd1] ? 0 : w[page + 0xbc] ? 1 : 2;
    const t = HUDX_TILE0 + 16 * e + FACES[face]!;
    const attr = face === 0 ? 0x2800 : 0x2400;
    if (panel === 0) {
      put(c, panel, row, col, attr | H_FLIP | (t + 1));
      put(c, panel, row, col + 1, attr | H_FLIP | t);
      put(c, panel, row + 1, col, attr | H_FLIP | (t + 3));
      put(c, panel, row + 1, col + 1, attr | H_FLIP | (t + 2));
    } else {
      put(c, panel, row, col, attr | t);
      put(c, panel, row, col + 1, attr | (t + 1));
      put(c, panel, row + 1, col, attr | (t + 2));
      put(c, panel, row + 1, col + 1, attr | (t + 3));
    }
    // name
    for (let k = 0; k < 4; k++) put(c, panel, row, col + 3 + k, 0x2100 | (HUDX_TILE0 + 16 * e + 12 + k));
    // life bar
    const target = c.rom.u8(LIFE_BARS + w[page + 0x79]!);
    let shown = w[page + 0x1db]!;
    if (target >= shown) shown = target;
    else if (w[page + 0xd1]) shown = 0;
    else shown--;
    w[page + 0x1db] = shown;
    const band = shown < 0x28 ? 0x1000 : shown < 0x50 ? 0x1400 : 0x1800;
    const v = shown < 0x28 ? shown : shown < 0x50 ? shown - 0x28 : shown - 0x50;
    const full = v >> 3;
    for (let k = 0; k < 5; k++) put(c, panel, row + 1, col + 2 + k, band | (k < full ? 0x2108 : k === full ? 0x2100 | (v & 7) : 0x2100));
    put(c, panel, row + 1, col + 7, band | 0x2109);
  }
}

export function installHud(r: Runner, extraChars: (c: Machine) => number[]): void {
  // C025F7, after C025C9 copied the four players' portrait blocks
  r.override(0xc025f7, (c) => {
    const chars = extraChars(c);
    if (chars.length) loadPortraits(c, chars);
    return r.original(c, 0xc025f7);
  });
  // the match clock C0620D, once a frame of a match
  r.override(0xc0620d, (c) => {
    if (bigTeams(c)) {
      c.tick(300);
      draw(c);
    } else c.hudxRows = 0;
    return r.original(c, 0xc0620d);
  });
}
