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
 * With a wide picture (Machine.wide = M, wide.ts) the screen reaches M further on each side:
 * the x margins and the off-screen values move out by M and the clamps in by M, so the wide
 * picture stays inside the arena (x 20 - M .. 160 + M + 256 + M).
 *
 * With a taller picture (Machine.tall) one y rule, on the ring or the floor (tallY): the
 * middle of the wrestlers' feet lines (depth - lift - camera y) at FEET_MIDDLE, the front one
 * at FEET_BOTTOM at most and the back one at FEET_TOP at least while they fit (the singles
 * floor margins, the bottom one lower), the target gliding toward it (an eighth of the way a
 * frame, 1..4); when they do not fit, the back one is left out at the top. The front limit
 * holds at once, without gliding: the floor walk (C18F05) keeps a wrestler's depth within D0 of
 * the target, so a camera above that would pull him back toward the ring. The original ring rule keeps the front feet near line D8 (much of the crowd,
 * no apron) and switches to the floor margins when someone is out, a jump of about 24 lines.
 * The camera y is at least PICTURE_TOP, so the top line shows no more of the arena than the
 * original's top line did.
 *
 * Then the original tail (C1202F: D = 0, smoothing C1BB53).
 */
import type { Machine } from '@ssm/core';
import { PICTURE_TOP } from './wide.ts';

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

/** the feet lines of the taller picture's camera (tallY) */
const FEET_MIDDLE = 0xbc;
const FEET_TOP = 0x58;
const FEET_BOTTOM = 0xc8;

/** The camera y target of the taller picture: framed on the feet lines, gliding. */
function tallY(c: Machine, active: number[], target: number): number {
  const w = c.wram;
  const rd = (a: number) => w[a]! | (w[a + 1]! << 8);
  let back = 0x7fff;
  let front = -0x8000;
  for (const d of active) {
    const feet = s16(rd(d + 0x1b) - w[d + 0x71]!);
    back = Math.min(back, feet);
    front = Math.max(front, feet);
  }
  let want = ((back + front) >> 1) - FEET_MIDDLE;
  if (front - back <= FEET_BOTTOM - FEET_TOP) {
    if (front - want > FEET_BOTTOM) want = front - FEET_BOTTOM;
    if (back - want < FEET_TOP) want = back - FEET_TOP;
  }
  const d = want - s16(target);
  const step = Math.max(1, Math.min(4, Math.abs(d) >> 3));
  let y = d === 0 ? s16(target) : s16(target) + (d > 0 ? step : -step);
  // the front one at once: on the floor, C18F05 puts back whoever walks D0 below the target
  if (front - y > FEET_BOTTOM) y = front - FEET_BOTTOM;
  return y;
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
  const m = c.wide;
  let cam = rd(0x1a8a);
  let left = s16(rd(0x2c) - cam);
  if (left < -m) left = 0x10 - m;
  left = (left - (0x30 - m)) & 0xffff;
  let right = s16(rd(0x30) - cam);
  if (right >= 0xf0 + m) right = 0xf0 + m;
  right = (right - (0xd0 + m)) & 0xffff;
  const dx = pull(left, right);
  let x = s16(cam + dx);
  if (x < 0x20 + m) x = 0x20 + m;
  else if (x > 0x160 - m) x = 0x160 - m;
  const limit = rd(0x1a91);
  const dir = rd(0x1a93);
  if (dir !== 0 && ((dir & 0x8000) === 0 ? limit >= x : limit < x)) x = limit;
  wr(0x1a8a, x);

  // y
  cam = rd(0x1a8d);
  let y: number;
  if (c.tall) y = tallY(c, active, cam);
  else if (onFloor) {
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
  const top = c.tall ? PICTURE_TOP : 0; // a taller picture (wide.ts)
  if (y < top) y = top;
  else if (y > 0xc0) y = 0xc0;
  wr(0x1a8d, y);
  return CAMERA_TAIL;
}
