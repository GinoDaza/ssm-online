/**
 * Sprite memory for team matches in the singles arena. Sprite VRAM (C000-FFFF) cannot hold
 * both environments: team play streams its four wrestlers into D000-FFFF (C00971: slots
 * D000 / DC00 / E800 / F400) and keeps its tags in C000-CFFF (VRAM list 73), while the singles
 * arena keeps the side-rope tiles at DC00 and its own C000-CFFF (list 72), and streams the
 * ringside items (and the ropes' shake frames) into D000-DFFF through the graphics queue
 * (C00A8C). The original solved it by giving team play an arena without them.
 *
 * Here the singles sprites use the Machine's second sprite bank (objx):
 * - arena set-up (after C01FB8 loads list 72): sprite VRAM C000-DFFF is copied to the bank,
 *   then list 73's part of C000-CFFF goes back to VRAM for the team tags;
 * - graphics queue (C00AC0, one record built): a record for D000-DFFF gets VMAIN bit 6, so its
 *   DMA lands in the bank; in team play nothing else is queued there (wrestlers use C00A2B);
 * - drawing (C1F6C7 / C1F74C / C1F7BB, the drawers, X = the object): the entries of the
 *   objects that draw singles graphics are flagged to take their tiles from the
 *   bank: the items, the side ropes 22 / 24, and the combat effects 3C (their floor-impact
 *   frames use tiles that team play's set replaces with its letters; their other tiles are the
 *   same in both sets). Every other object draws team tiles or tiles both sets share (measured
 *   over team matches from the ring load to the result: the arrows 4A, the marks 66, the
 *   "BATTLE / FIGHT" text 64 and the match-end texts 10 / 16 / 9E are team tiles).
 * - the flags stay while the arena does (its side ropes 22 in the object pool): a paused game
 *   uploads the same OAM without drawing again. Once the pool no longer has the arena (the
 *   screens after the match clear it), C00369 (the interrupt, after the OAM upload) clears
 *   them, so those screens never inherit them.
 * - palettes: the same for the sprite palettes. Singles keep the items' colors in palette 7
 *   (palette list 4, loaded by the ring load C01FB8), team play gives palettes 4-7 to its four
 *   wrestlers (C18B80). The bank's palettes follow the game's (its CGRAM buffer 3100-31DF,
 *   copied when the IRQ uploads it, C00282), but palette 7 holds the items' colors from that list.
 */
import { OBJX_BANK2, rtl, type Machine, type Runner } from '@ssm/core';
import { oamIndex, oamPassStart } from './oamext.ts';
import { EXT, EXTRA, bigTeams, extras, isExtra, rd16, setTeamSize, wr16 } from './slots.ts';
import { isLeftRope } from './ropes.ts';
import { setTall } from './wide.ts';

const TEAM_FLAG = 0x1ba0;
const TEAM_BIT = 0x40;
const isTeam = (c: Machine) => (c.wram[TEAM_FLAG]! & TEAM_BIT) !== 0;

/** VRAM lists: word pointers at C0:8BCE, read with DB = 80 (bank C0). */
const VRAM_LISTS = 0xc08bce;
/** WRAM lists (C0075A), the same entries: word pointers at C0:933F */
export const WRAM_LISTS = 0xc0933f;
const TEAM_ARENA_LIST = 73;
const SPRITES = 0xc000;
const TEAM_TAGS = [0xc000, 0xd000] as const;
const SINGLES_STREAM = [0xd000, 0xe000] as const;
/** pool types that draw singles graphics */
const SINGLES_GRAPHICS = new Set([0x22, 0x24, 0x3c]);
/**
 * `oamx` bit 4, color math whatever the palette: the team result screens darken the picture
 * with color math, which the SNES never gives sprite palettes 0-3. The team arena's own ropes
 * are BG tiles and darken; the singles objects here use palettes 0 and 1 (the side ropes),
 * so they darken with the team wrestlers. During play the fixed color is 0: no change.
 */
const MATH = 0x10;


interface Entry {
  /** VRAM byte address */
  dest: number;
  data: Uint8Array;
}

/**
 * Decode a VRAM list from the ROM as C00643 / C006E7 load it (or, with `table` = WRAM_LISTS, a
 * WRAM list as C0075A does; `dest` is then the WRAM address, bit 0 the bank).
 */
export function vramList(c: Machine, list: number, table = VRAM_LISTS): Entry[] {
  const u8 = (a: number) => c.rom.u8(a);
  const u16 = (a: number) => u8(a) | (u8(a + 1) << 8);
  const out: Entry[] = [];
  for (let p = 0xc00000 | u16(table + 2 * list); ; p += 7) {
    const size = u16(p);
    if (size & 1) break;
    const dest = table === VRAM_LISTS ? (u16(p + 2) << 1) & 0xffff : u16(p + 2);
    const src = u16(p + 4);
    const bank = u8(p + 6);
    const data = new Uint8Array(size);
    if (bank & 0xc0) {
      for (let i = 0; i < size; i++) data[i] = u8((bank << 16) | ((src + i) & 0xffff));
    } else {
      // 16-byte blocks, floor(size / 16) + 1 of them: 15 then 16 literals, or a fill byte and a
      // 16-bit mask, most significant bit first (1: the next literal, 0: the fill)
      let a = ((bank | 0xc0) << 16) | src;
      let o = 0;
      const put = (v: number) => {
        if (o < size) data[o] = v;
        o++;
      };
      for (let left = size; left >= 0; left -= 16) {
        const b = u8(a++);
        if (b === 0x15) {
          for (let k = 0; k < 16; k++) put(u8(a++));
          continue;
        }
        const mask = (u8(a) << 8) | u8(a + 1);
        a += 2;
        for (let k = 15; k >= 0; k--) put((mask >> k) & 1 ? u8(a++) : b);
      }
    }
    out.push({ dest, data });
  }
  return out;
}

/** Palette lists (C00E47): word pointers at C0:9C62; entries count, first color, CB source. */
const PALETTE_LISTS = 0xc09c62;
const RING_PALETTES = 4;
/** palette 7 in the sprite palettes (byte offset) */
const ITEM_PALETTE = 7 * 0x20;
/** the game's CGRAM buffer, sprite palettes 0-6 */
const SPRITE_PALETTES = [0x3100, 0x31e0] as const;

/** The sprite colors (CGRAM 80-FF) a palette list sets, into `into` (256 bytes). */
export function spritePalettes(c: Machine, list: number, into: Uint8Array): void {
  const u8 = (a: number) => c.rom.u8(a);
  for (let p = 0xc00000 | u8(PALETTE_LISTS + 2 * list) | (u8(PALETTE_LISTS + 2 * list + 1) << 8); u8(p) !== 0; p += 4) {
    const count = u8(p);
    const first = u8(p + 1);
    const src = 0xcb0000 | u8(p + 2) | (u8(p + 3) << 8);
    for (let k = 0; k < count; k++) {
      const color = first + k;
      if (color < 0x80 || color > 0xff) continue;
      into[2 * (color - 0x80)] = u8(src + 2 * k);
      into[2 * (color - 0x80) + 1] = u8(src + 2 * k + 1);
    }
  }
}

/** After the arena's VRAM list: singles sprite tiles to the bank, team tags back to VRAM. */
function splitSpriteMemory(c: Machine): void {
  const ring = new Uint8Array(0x100);
  spritePalettes(c, RING_PALETTES, ring);
  c.cgramx.set(ring.subarray(ITEM_PALETTE, ITEM_PALETTE + 0x20), ITEM_PALETTE);
  c.objx.set(c.vram.subarray(SPRITES, SPRITES + 0x2000), 0);
  for (const { dest, data } of vramList(c, TEAM_ARENA_LIST)) {
    for (let i = 0; i < data.length; i++) {
      const a = dest + i;
      if (a >= TEAM_TAGS[0] && a < TEAM_TAGS[1]) c.vram[a] = data[i]!;
    }
  }
}

function arenaPresent(c: Machine): boolean {
  for (let d = 0x1200; d < 0x1a00; d += 0x40) if (c.wram[d] !== 0 && c.wram[d + 1] === 0x22) return true;
  return false;
}

/** `menus`: once a frame outside a match, after the match picture is cleared (menus.ts) */
export function installSprites(r: Runner, menus?: (c: Machine) => void): void {
  // C01FE3 follows the arena list load (C01FE0 JSR C00643) in C01FB8
  r.split(0xc01fe6);
  r.override(0xc01fe3, (c) => {
    if (isTeam(c)) splitSpriteMemory(c);
    return r.original(c, 0xc01fe3);
  });

  // C00AC0: a queue record was built at X; A = its VRAM word (bit 15: the last one)
  r.split(0xc00ac2);
  r.override(0xc00ac0, (c) => {
    const at = (c.a & 0x7fff) << 1;
    if (isTeam(c) && at >= SINGLES_STREAM[0] && at < SINGLES_STREAM[1]) c.wram[c.x]! |= 0x40;
    return r.original(c, 0xc00ac0);
  });

  r.split(0xc0036b);
  r.override(0xc00369, (c) => {
    if (!arenaPresent(c)) {
      c.oamxNext.fill(0);
      c.wide = 0; // the wide and tall picture is the arena's (wide.ts)
      setTall(c, false);
      c.hudxRows = 0;
      menus?.(c);
    }
    // the extra wrestlers are the match's (set by its start C189BC, state 18), not the screens'
    // after it (from 20 on, which use ext WRAM as a buffer) or before
    if (bigTeams(c)) uploadExtraTiles(c); // with the frames of the DMA list (C0036D)
    const state = c.wram[0x56]!;
    if (state < 0x14 || state >= 0x20) setTeamSize(c, 2);
    return r.original(c, 0xc00369);
  });

  // C00282 (LDA $D5, the IRQ's CGRAM upload, right after the OAM's): the banks' palettes go
  // with them, so a palette shows with the OAM it was set with
  r.override(0xc00282, (c) => {
    bankPalettes(c);
    return r.original(c, 0xc00282);
  });

  // the drawing pass C1F5A2 starts with no flags; then each drawer's entries, from $F4 on, are
  // its object's until the next object starts (singles: only the wide picture's left side rope)
  r.split(0xc1f5a4);
  r.override(0xc1f5a2, (c) => {
    c.oamxNext.fill(0);
    oamPassStart(c);
    return r.original(c, 0xc1f5a2);
  });
  for (const drawer of [0xc1f6c7, 0xc1f74c, 0xc1f7bb]) {
    r.split(drawer + 2);
    r.override(drawer, (c) => {
      const d = c.x;
      let flags = !isTeam(c)
        ? 0
        : isExtra(d)
          ? 4 // an extra wrestler or its companion piece (+1C9)
          : (d >= 0x1000 && d < 0x1200) || (d >= 0x1200 && d < 0x1a00 && SINGLES_GRAPHICS.has(c.wram[d + 1]!))
            ? 1 | MATH
            : 0;
      // the left side rope's frame, in bank 1's other half (ropes.ts)
      if (isLeftRope(c, d)) flags |= 1 | 8;
      c.oamxNext.fill(flags, oamIndex(c));
      return r.original(c, drawer);
    });
  }

  installExtraGraphics(r);
}

/** bank 2's palettes in Machine.cgramx */
const BANK2_PALETTES = 0x100;
/** OBJ VRAM words of the wrestler slots 0-3 (C00971: 0800 at 7A00 ... 0E00 at 6800) */
const SLOT_VRAM = [0x7a00, 0x7400, 0x6e00, 0x6800] as const;

/** Copy `size` bytes from the ROM to bank 2 at the VRAM byte address `dest`. */
function toBank2(c: Machine, src: number, size: number, dest: number): void {
  for (let i = 0; i < size; i++) {
    const o = c.objxOffset((dest + i) & 0xffff);
    if (o >= 0) c.objx[OBJX_BANK2 + o] = c.peek8((src & 0xff0000) | ((src + i) & 0xffff));
  }
}

/** The sprite banks' palettes from the game's CGRAM buffer, when the IRQ uploads it (C00282). */
function bankPalettes(c: Machine): void {
  if (!isTeam(c) && c.wide) c.cgramx.set(c.wram.subarray(SPRITE_PALETTES[0], SPRITE_PALETTES[0] + 0x100), 0);
  if (isTeam(c)) {
    c.cgramx.set(c.wram.subarray(SPRITE_PALETTES[0], SPRITE_PALETTES[1]), 0);
    // bank 2 (the extra wrestlers): the game's palettes, 4-7 the extras' own
    c.cgramx.set(c.wram.subarray(SPRITE_PALETTES[0], SPRITE_PALETTES[0] + 0x80), BANK2_PALETTES);
    c.cgramx.set(c.wram.subarray(EXT.PALETTES, EXT.PALETTES + 0x80), BANK2_PALETTES + 0x80);
  }
}

const QUEUE_BYTES = 6;
/** C0:D532, the word C00971 puts in `$04`: the companion pieces' record table (bank C5) */
const COMPANION_TABLE = 0xc0d532;

/**
 * The extra wrestlers' frame requests (+50 for C00A2B, +1D9 for C00AD5), taken when the IRQ
 * builds the DMA list (C00971, about line 80, while the picture is drawn). The base slots' frames
 * reach VRAM when that list runs, in the next vertical blank, with the OAM drawn for them; the
 * extras' wait for the same moment (uploadExtraTiles). A newer request replaces one still waiting
 * (a frame the IRQ skipped): only the latest frame is drawn.
 */
function queueExtraTiles(c: Machine): void {
  const w = c.wram;
  EXTRA.slice(0, extras(c)).forEach((page, e) => {
    const q = EXT.TILE_QUEUE + QUEUE_BYTES * e;
    if (w[page + 0x50]) {
      w[page + 0x50] = 0;
      w[q] = w[q]! | 1;
      wr16(c, q + 1, rd16(c, page + 0x4b));
      wr16(c, q + 3, rd16(c, page + 0x4e));
    }
    if (w[page + 0x1d9]) {
      w[q] = w[q]! | 2;
      w[q + 5] = w[page + 0x1d9]!;
      w[page + 0x1d9] = 0;
    }
  });
}

/**
 * The waiting frames into sprite bank 2, at the VRAM place of the base slot each extra mirrors,
 * when the IRQ runs the DMA list (C00369). Bank 2 is not VRAM, so the copy is direct instead of
 * DMA records: it takes no room in the DMA list (0400, A0 bytes).
 */
function uploadExtraTiles(c: Machine): void {
  const w = c.wram;
  const rom16 = (a: number) => c.peek8(a) | (c.peek8((a & 0xff0000) | ((a + 1) & 0xffff)) << 8);
  EXTRA.slice(0, extras(c)).forEach((_, e) => {
    const vram = SLOT_VRAM[e]!;
    const q = EXT.TILE_QUEUE + QUEUE_BYTES * e;
    const what = w[q]!;
    w[q] = 0;
    if (what & 1) {
      const f = rd16(c, q + 1) & 0x1ff;
      let p = 0xc50000 | rom16(0xc50000 | ((2 * f + rd16(c, q + 3)) & 0xffff));
      for (let k = 0; k < 32; k++) {
        const n = c.peek8(p);
        if (!n) break;
        const size = (n << 4) & 0xfff;
        const src = (c.peek8(p + 3) << 16) | rom16(p + 1);
        const hi = (c.peek8(p + 4) + (vram >> 8)) & 0xff;
        toBank2(c, src, size, ((hi & 0x7f) << 9) & 0xffff);
        c.tick(8 * size);
        if (hi & 0x80) break;
        p = 0xc50000 | ((p + 5) & 0xffff);
      }
    }
    if (what & 2) {
      let p = 0xc50000 | rom16(0xc50000 | ((rom16(COMPANION_TABLE) + w[q + 5]!) & 0xffff));
      for (let k = 0; k < 32; k++) {
        const size = rom16(p);
        const src = (c.peek8(p + 4) << 16) | rom16(p + 2);
        const word = (rom16(p + 5) + vram) & 0xffff;
        toBank2(c, src, size, (word << 1) & 0xffff);
        c.tick(8 * size);
        if (word & 0x8000) break;
        p = 0xc50000 | ((p + 7) & 0xffff);
      }
    }
  });
}

/**
 * C18B7D (the palette of the wrestler at D, variant +54) for an extra slot: the colours of the
 * base slot it mirrors (team: variant slot + 1, slot 2 takes 5), into its bank-2 palette.
 */
function extraPalette(c: Machine): void {
  const w = c.wram;
  const page = c.d;
  const e = (page - EXTRA[0]) >> 9;
  const v = ((e === 2 ? 4 : e) + 1 + w[page + 0x54]!) & 0xff;
  const off = (((v << 4) & 0xff) << 1) & 0x1ff;
  const root = w[page + 0x51]! | (w[page + 0x52]! << 8) | (w[page + 0x53]! << 16);
  for (let i = 0; i < 32; i++) w[EXT.PALETTES + 0x20 * e + i] = c.peek8((root + off + i) & 0xffffff);
  w[0xd5] = 1;
}

function installExtraGraphics(r: Runner): void {
  // C009E5 SEP #$30, after the four slots of C00971 (D = 0)
  r.override(0xc009e5, (c) => {
    if (bigTeams(c)) queueExtraTiles(c);
    return r.original(c, 0xc009e5);
  });
  r.override(0xc18b7d, (c) => {
    if (!bigTeams(c) || !isExtra(c.d)) return r.original(c, 0xc18b7d);
    c.tick(500);
    extraPalette(c);
    return rtl(c);
  });
}
