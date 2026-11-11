/**
 * Ringside items in team matches (singles arena). Singles run them every frame from the match
 * order C00F81: the singles parent C11001 first throws a new item in now and then (C11007-
 * C11039: while `$1A72` is set and the four item slots 1000-1180 are empty, an RNG draw
 * either ends the supply or, with both wrestlers on the ring, calls C18CB3), then C2032D
 * moves and draws the items. The team order (C00FAF) has neither. Picking up (C1A3C5),
 * carrying and hitting with an item are wrestler code shared by both modes; the items are set
 * up at the match start by C18BBF (an arena site in full-arena.ts).
 *
 * The team order gets both steps after its parent C11BD3, before the contact root, as in
 * singles, by running the original code:
 *   C00FBA (JSL C1A9C7)  -> push P, D = 0, 16-bit, continue at C11007 (the singles spawn step)
 *   C1102F (team)        -> "on the ring" asks all four wrestlers, not just 0800 / 0A00
 *   C1103A (team)        -> JSL C2032D, returning to RETURN
 *   RETURN               -> pull P, then the original JSL C1A9C7 from C00FBA
 * Every return address lives on the game's stack, so rollback snapshots hold it.
 */
import type { Machine, Runner } from '@ssm/core';
import { pages } from './slots.ts';

/** A never-executed address (padding of FF bytes, C07E57-C07FFF) used as a return target. */
export const RETURN = 0xc07f00;

const TEAM_FLAG = 0x1ba0;
const TEAM_BIT = 0x40;

const isTeam = (c: Machine) => (c.wram[TEAM_FLAG]! & TEAM_BIT) !== 0;

/** JSL from FastROM: four fetches and an internal cycle (the pushes go through the bus). */
function jsl(c: Machine, target: number, returnTo: number): number {
  c.tick(4 * c.fast + 6);
  c.push8(returnTo >>> 16);
  c.push16((returnTo - 1) & 0xffff);
  return target;
}

export function installItems(r: Runner): void {
  r.override(0xc00fba, (c) => {
    c.tick(2 * c.fast + 6); // PHP, TCD-like set-up
    c.push8(c.p);
    c.d = 0;
    c.setP(c.p & ~0x30);
    return 0xc11007;
  });

  r.split(0xc11035);
  r.override(0xc1102f, (c) => {
    if (!isTeam(c)) return r.original(c, 0xc1102f);
    c.tick(6 * c.fast);
    let side = 0;
    for (const d of pages(c)) side |= c.read16(d + 0x6f);
    c.a = side;
    c.n = (side & 0x8000) !== 0;
    c.z = side === 0;
    return 0xc11035;
  });

  r.split(0xc1103c);
  r.override(0xc1103a, (c) => (isTeam(c) ? jsl(c, 0xc2032d, RETURN) : r.original(c, 0xc1103a)));

  r.override(RETURN, (c) => {
    c.setP(c.pull8());
    return jsl(c, 0xc1a9c7, 0xc00fbe);
  });
}
