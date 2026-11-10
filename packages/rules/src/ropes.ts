/**
 * The side ropes on the wide picture. The arena has two side-rope objects 22 (C20FC2, +02 = 0
 * the left one at x 98, 1 the right one at x 1E8), each shaken by its own level (`$1A76` /
 * `$1A77`), whose frame (+1F, C0:CCF3[level]) is a set of tiles uploaded to one place, sprite
 * VRAM DC00-DF7F (graphics queue entries 0-5, C00A8C: 380 bytes each from WRAM 7E:9480-A9FF). The
 * last frame uploaded is `$1A79`. Only a rope on screen uploads its frame (the cull C21048
 * before it), and the SNES screen never shows both, so the one place is enough.
 *
 * The wide screen shows both most of the time: both upload, the right one last, and the left
 * rope's pieces are drawn with the right rope's tiles (broken fragments while one shakes). Here
 * the left rope does not upload: its frame is copied from the ROM's record straight into the
 * other half of sprite bank 1 (the Machine extension, unused there in both environments), and
 * its entries take their tiles from it (`oamx` bits 0 and 3, sprites.ts). The right rope keeps
 * the original's upload.
 */
import type { Machine, Runner } from '@ssm/core';

/** C21035 SEP #$20, after the cull passed: then the frame upload when +1F != `$1A79` */
const UPLOAD = 0xc21035;
const DRAW = 0xc21044;
const ROPE = 0x22;
/** graphics queue record lists: C5:word[C0:D530] + 2 * entry (C00A8C) */
const QUEUE_LISTS = 0xc0d530;
/** where the left rope's frame goes in objx: bank 1's other half */
const OTHER_HALF = 0x2000;

/** The left side rope, on the wide picture: object D is it. */
export const isLeftRope = (c: Machine, d: number) => c.wide !== 0 && c.wram[d + 1] === ROPE && c.wram[d + 2] === 0;

/** Copy the records of graphics queue entry `entry` into objx, in the other half of bank 1. */
function frameToBank(c: Machine, entry: number): void {
  const u8 = (a: number) => c.rom.u8(a);
  const u16 = (a: number) => u8(a) | (u8(a + 1) << 8);
  for (let p = 0xc50000 | u16(0xc50000 | (u16(QUEUE_LISTS) + 2 * entry)); ; p += 8) {
    const size = u16(p + 1);
    const src = (u8(p + 5) << 16) | u16(p + 3);
    const word = u16(p + 6);
    const o = c.objxOffset((word << 1) & 0xffff);
    if (o >= 0 && o < OTHER_HALF) {
      for (let i = 0; i < size && o + i < OTHER_HALF; i++) {
        c.objx[OTHER_HALF + o + i] = c.peek8((src & 0xff0000) | ((src + i) & 0xffff));
      }
    }
    if (word & 0x8000) break;
  }
}

export function installRopes(r: Runner): void {
  r.split(UPLOAD + 2);
  r.override(UPLOAD, (c) => {
    if (!isLeftRope(c, c.d)) return r.original(c, UPLOAD);
    c.tick(3 * c.fast);
    c.setP(c.p | 0x20);
    frameToBank(c, c.wram[c.d + 0x1f]!);
    return DRAW;
  });
}
