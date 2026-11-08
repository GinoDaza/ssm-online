/**
 * The overrides a Ruleset needs (Runner.override, docs/architecture.md). Classic installs
 * none, so the game is the original.
 *
 * Leaving the ring in team play. One routine (C13750) turns the held direction and the rope
 * contact into the next state. On the ring it ends at C13817: in singles, pushing into the
 * side ropes climbs out (C1351E, state 28) and into the front / back ones goes through them
 * (C13663, state 2A); in team play (`BIT $1B9F; BVS`, the team bit) it bounces instead
 * (C13836). On the floor, C13766 (`BIT $1BA0; BVS`) sends team play to the ring path, singles to
 * climbing back in (C13849, state 2E). Both tests are replaced by the same instructions with
 * the team bit hidden, at the same cost, so the singles paths run.
 */
import type { Game, Machine } from '@ssm/core';
import type { Ruleset } from './ruleset.ts';

/** `BIT abs; BVS` in FastROM bank C1, with V clear: falls through to `next`. */
function bitNoV(c: Machine, addr: number, next: number): number {
  c.tick(3 * c.fast);
  const ea = (c.db << 16) | addr;
  const v = c.m ? c.read8(ea) : c.read16(ea);
  const mask = c.m ? 0xff : 0xffff;
  c.n = (v & (c.m ? 0x80 : 0x8000)) !== 0;
  c.z = (c.a & v & mask) === 0;
  c.v = false;
  c.tick(2 * c.fast); // BVS, not taken
  return next;
}

/** Register the overrides of `rules` on a game (before it runs). */
export function installRules(game: Game, rules: Ruleset): void {
  const r = game.runner;
  if (rules.canLeaveRing(true)) {
    r.override(0xc13817, (c) => bitNoV(c, 0x1b9f, 0xc1381c));
    r.override(0xc13766, (c) => bitNoV(c, 0x1ba0, 0xc1376b));
  }
}
