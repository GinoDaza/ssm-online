/**
 * The arena objects of a team match in the singles arena. At the match start C02631 creates the
 * arena's objects from a table: C0:A055 in singles, C0:A07C in team play (the team bit picks).
 * Singles have what the singles arena needs: object 38 (C2145A, HDMA channel 6, the per-line
 * BG2 scroll that draws the ring's ropes and floor), the side ropes 22 (C20FC2, shaken by a
 * hit) and their pieces 24 (C21065). Team play has its own: a second follower 3A, 7C, an arrow
 * 4A per wrestler, the marks 66. Both sets are created: the team table, then what only the
 * singles table has, the same way (C20128 then type, argument, +00 + 1).
 */
import type { Machine } from '@ssm/core';

const SINGLES_TABLE = 0xc0a055;
const TEAM_TABLE = 0xc0a07c;
const POOL = 0x1200;
const POOL_END = 0x1a00;

function table(c: Machine, at: number): [number, number][] {
  const out: [number, number][] = [];
  for (let a = at; c.rom.u8(a) < 0x80; a += 2) out.push([c.rom.u8(a), c.rom.u8(a + 1)]);
  return out;
}

/** C02631 for team matches in the singles arena; returns from it as its RTS would. */
export function createArenaObjects(c: Machine): number {
  const team = table(c, TEAM_TABLE);
  const has = new Set(team.map(([t, a]) => (t << 8) | a));
  const objects = [...team, ...table(c, SINGLES_TABLE).filter(([t, a]) => !has.has((t << 8) | a))];
  const w = c.wram;
  for (const [type, arg] of objects) {
    let slot = POOL;
    while (slot < POOL_END && (w[slot]! | w[slot + 1]!) !== 0) slot += 0x40;
    c.tick(60); // the allocator's scan and the stores, about
    if (slot >= POOL_END) break;
    w[slot + 1] = type;
    w[slot + 2] = arg;
    w[slot] = (w[slot]! + 1) & 0xff;
    c.x = slot;
  }
  w[0x1a79] = 0;
  c.setP(c.p | 0x30);
  return (c.pb << 16) | ((c.pull16() + 1) & 0xffff);
}
