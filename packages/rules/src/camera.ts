/**
 * The camera of team matches in the singles arena: replaces the target step of the team
 * parent (C11F71-C1202E), which keeps the camera inside the narrow team arena (x 60..120,
 * y up to 68), with the singles camera's rules (C1B90B) over the four wrestlers.
 *
 * Wrestlers counted: those the team loop collects (C11F3D: +76 nonzero, header bit 7). The
 * loop has already left min x in $2C, max x in $30, the count in $24.
 *
 * - x: the team move (C11F7B-C11FDD: margins 30 / D0 from the outermost wrestlers, no move when
 *   they pull opposite ways, else the smaller pull), then the singles floor clamps (C1BA7D:
 *   20..160) and the directional limit $1A91 / $1A93 (C1BAC2). Not the singles snap to an
 *   arena side while someone is beside the apron (C1BA9A): with four wrestlers it would leave
 *   the others off screen. As in team play, whoever falls outside the picture is pulled back in
 *   (C18E49), so every player stays visible.
 * - y with someone on the floor: the singles floor rule (C1BAE3): margins 58 / C0 from the
 *   nearest and deepest wrestler, the same pull choice, 0..C0.
 * - y with everyone on the ring: the team rule (C12012: deepest depth less its lift, a dead
 *   band of 4) with the singles margin D8 (C1BA0B) and range 0..C0.
 *
 * Then the original tail (C1202F: D = 0, smoothing C1BB53).
 */
import type { Machine } from '@ssm/core';

const SLOTS = [0x0800, 0x0a00, 0x0c00, 0x0e00];
/** the original tail: D = 0, C1BB53, RTL */
export const CAMERA_TAIL = 0xc1202f;

const s16 = (v: number) => ((v & 0xffff) << 16) >> 16;

/**
 * The move that brings both pulls in: none when they point opposite ways, else the smaller one
 * (both positive: min; both negative: the one nearer zero), as C11FBA / C1BA5D / C1BB0F.
 */
function pull(near: number, far: number): number {
  if ((near ^ far) & 0x8000) return 0;
  if (far & 0x8000) return far >= near ? far : near; // both negative, compared unsigned as the code does
  return far >= near ? near : far;
}

export function teamArenaCamera(c: Machine): number {
  const w = c.wram;
  const rd = (a: number) => w[a]! | (w[a + 1]! << 8);
  const wr = (a: number, v: number) => {
    w[a] = v & 0xff;
    w[a + 1] = (v >> 8) & 0xff;
  };
  c.tick(1500); // about the original's cost; deterministic either way
  if (rd(0x24) === 0) return CAMERA_TAIL;

  const active = SLOTS.filter((d) => w[d + 0x76] !== 0 && (w[d]! & 0x80) !== 0);
  let side = 0;
  for (const d of active) side |= rd(d + 0x6f);
  wr(0x1a8f, side);
  const onFloor = active.some((d) => rd(d + 0x6f) !== 0);

  // x
  let cam = rd(0x1a8a);
  let left = s16(rd(0x2c) - cam);
  if (left < 0) left = 0x10;
  left = (left - 0x30) & 0xffff;
  let right = s16(rd(0x30) - cam);
  if (right >= 0xf0) right = 0xf0;
  right = (right - 0xd0) & 0xffff;
  const dx = pull(left, right);
  let x = s16(cam + dx);
  if (x < 0x20) x = 0x20;
  else if (x > 0x160) x = 0x160;
  const limit = rd(0x1a91);
  const dir = rd(0x1a93);
  if (dir !== 0 && ((dir & 0x8000) === 0 ? limit >= x : limit < x)) x = limit;
  wr(0x1a8a, x);

  // y
  cam = rd(0x1a8d);
  let y: number;
  if (onFloor) {
    let nearest = 0xffff;
    let deepest = 0;
    for (const d of active) {
      const depth = rd(d + 0x1b);
      nearest = Math.min(nearest, depth);
      deepest = Math.max(deepest, depth);
    }
    const top = (nearest - cam - 0x58) & 0xffff;
    const bottom = (deepest - cam - 0xc0) & 0xffff;
    y = s16(cam + pull(top, bottom));
  } else {
    let deepest = 0;
    for (const d of active) deepest = Math.max(deepest, rd(d + 0x1b) - w[d + 0x71]!);
    let dy = s16(deepest - cam - 0xd8);
    if (dy >= 0) dy = dy >= 4 ? dy - 4 : 0;
    y = s16(cam + dy);
  }
  if (y < 0) y = 0;
  else if (y > 0xc0) y = 0xc0;
  wr(0x1a8d, y);
  return CAMERA_TAIL;
}
