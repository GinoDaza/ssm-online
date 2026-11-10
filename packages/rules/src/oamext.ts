/**
 * More sprites for 3 vs 3 and 4 vs 4: the second OAM (Machine.oamExt). The OBJ pass C1F5A2
 * builds the OAM in 7E:3200-341F (pieces through the WRAM port at 3200 + 4 `$F4`, two high-table
 * bits each into `$F3`, flushed to 3400 + `$F5`); when the high table's last byte (1F) is
 * stored the drawer gives up (C1F73D / C1F7AC / C1F87D: CPX #$1F, BCS to the pass tail C1F6A6),
 * the remaining objects are not drawn. Four wrestlers in the full arena already fill most of it.
 *
 * In a big team match the full buffer is put aside (EXT.OAM_STASH) instead, and the pass goes on
 * from entry 0 in the same buffer: its own high-byte flush and the clear of unused entries
 * (C1F66E-C1F6A4) run on it. At the tail it becomes the second OAM (oamExtNext, its pieces
 * counted by `$F4`) and the first comes back; `$F2` (last frame's count, which the next pass
 * clears up to) becomes 80. Both are committed with the next OAM DMA. A second overflow ends the
 * pass as the original's does. The drawers' per-entry flags (sprites.ts, wide.ts) are indexed
 * by oamIndex: entries of the second OAM are 128 and up.
 */
import type { Machine, Runner } from '@ssm/core';
import { EXT, bigTeams } from './slots.ts';

const OAM_BUFFER = 0x3200;
const OAM_BYTES = 0x220;
const FULL_CHECKS = [0xc1f73d, 0xc1f7ac, 0xc1f87d] as const;
const TAIL = 0xc1f6a6;

/** The OAM entry the next piece takes (0-255). */
export const oamIndex = (c: Machine) => (c.wram[0xf4]! & 0x7f) + (bigTeams(c) && c.wram[EXT.OAM_PHASE] ? 128 : 0);

/** At the OBJ pass start (sprites.ts, C1F5A2). */
export function oamPassStart(c: Machine): void {
  if (bigTeams(c)) c.wram[EXT.OAM_PHASE] = 0; // ext WRAM is the game's outside big matches
  c.oamExtCountNext = 0;
}

export function installOamExt(r: Runner): void {
  for (const pc of FULL_CHECKS) {
    r.override(pc, (c) => {
      if ((c.x & 0xff) !== 0x1f || !bigTeams(c) || c.wram[EXT.OAM_PHASE]) return r.original(c, pc);
      c.tick(2 * c.fast + 200);
      const w = c.wram;
      w.copyWithin(EXT.OAM_STASH, OAM_BUFFER, OAM_BUFFER + OAM_BYTES);
      w[EXT.OAM_PHASE] = 1;
      w[0xf4] = 0;
      w[0xf5] = 0;
      w[0xf3] = 0x80;
      c.wmaddr = OAM_BUFFER;
      // CPX #$1F as if below it: the drawer goes on
      c.c = false;
      c.z = false;
      c.n = true;
      return (pc & 0xff0000) | ((pc + 2) & 0xffff);
    });
  }
  r.override(TAIL, (c) => {
    const w = c.wram;
    if (bigTeams(c) && w[EXT.OAM_PHASE]) {
      c.tick(400);
      c.oamExtNext.set(w.subarray(OAM_BUFFER, OAM_BUFFER + OAM_BYTES));
      c.oamExtCountNext = w[0xf4]! & 0xff;
      w.copyWithin(OAM_BUFFER, EXT.OAM_STASH, EXT.OAM_STASH + OAM_BYTES);
      w[0xf4] = 0x80;
      w[EXT.OAM_PHASE] = 0;
    }
    return r.original(c, TAIL);
  });
}
