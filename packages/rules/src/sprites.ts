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
 * - drawing (C1F6C7 / C1F74C / C1F7BB, the drawers, X = the object): the entries an item or a
 *   singles rope (pool types 22 / 24) draws are flagged to take their tiles from the bank.
 * - palettes: the same for the sprite palettes. Singles keep the items' colors in palette 7
 *   (palette list 4, loaded by the ring load C01FB8), team play gives palettes 4-7 to its four
 *   wrestlers (C18B80). The bank's palettes follow the game's (its CGRAM buffer 3100-31DF,
 *   each drawing pass), but palette 7 holds the items' colors from that list.
 */
import type { Machine, Runner } from '@ssm/core';

const TEAM_FLAG = 0x1ba0;
const TEAM_BIT = 0x40;
const isTeam = (c: Machine) => (c.wram[TEAM_FLAG]! & TEAM_BIT) !== 0;

/** VRAM lists: word pointers at C0:8BCE, read with DB = 80 (bank C0). */
const VRAM_LISTS = 0xc08bce;
const TEAM_ARENA_LIST = 73;
const SPRITES = 0xc000;
const TEAM_TAGS = [0xc000, 0xd000] as const;
const SINGLES_STREAM = [0xd000, 0xe000] as const;
const SINGLES_ROPES = new Set([0x22, 0x24]);

interface Entry {
  /** VRAM byte address */
  dest: number;
  data: Uint8Array;
}

/** Decode a VRAM list from the ROM as C00643 / C006E7 load it. */
export function vramList(c: Machine, list: number): Entry[] {
  const u8 = (a: number) => c.rom.u8(a);
  const u16 = (a: number) => u8(a) | (u8(a + 1) << 8);
  const out: Entry[] = [];
  for (let p = 0xc00000 | u16(VRAM_LISTS + 2 * list); ; p += 7) {
    const size = u16(p);
    if (size & 1) break;
    const dest = (u16(p + 2) << 1) & 0xffff;
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

export function installSprites(r: Runner): void {
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

  // the drawing pass C1F5A2 starts with no flags; then each drawer's entries, from $F4 on, are
  // its object's until the next object starts (singles: never flagged)
  r.split(0xc1f5a4);
  r.override(0xc1f5a2, (c) => {
    c.oamxNext.fill(0);
    if (isTeam(c)) c.cgramx.set(c.wram.subarray(SPRITE_PALETTES[0], SPRITE_PALETTES[1]), 0);
    return r.original(c, 0xc1f5a2);
  });
  for (const drawer of [0xc1f6c7, 0xc1f74c, 0xc1f7bb]) {
    r.split(drawer + 2);
    r.override(drawer, (c) => {
      const d = c.x;
      const bank = isTeam(c) && ((d >= 0x1000 && d < 0x1200) || (d >= 0x1200 && d < 0x1a00 && SINGLES_ROPES.has(c.wram[d + 1]!)));
      c.oamxNext.fill(bank ? 1 : 0, c.wram[0xf4]! & 0x7f);
      return r.original(c, drawer);
    });
  }
}
