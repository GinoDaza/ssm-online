/**
 * Singles in the wide picture (Ruleset.wideSingles, docs/changes/wide-singles.md): the team
 * framing for the singles camera, and no PRESS / START labels at the bottom.
 */
import type { Runner } from '@ssm/core';
import { SINGLES_CAMERA, singlesWideCamera } from './camera.ts';

const TEAM_FLAG = 0x1ba0;
const TEAM_BIT = 0x40;

export function installWideSingles(r: Runner): void {
  // the singles camera: the original unless the picture is wide
  r.override(SINGLES_CAMERA, (c) => (c.wide ? singlesWideCamera(c) : r.original(c, SINGLES_CAMERA)));
  // the HUD jobs C05E1D: with more than two pads (`$7A`, the multitap) singles give objects
  // 2-3 a label job (8: PRESS / START for a challenger on pads 3-4) at the bottom of the
  // screen; the wide picture leaves them out (the top HUD already shows PRESS / START)
  r.override(0xc05e3d, (c) => {
    if (!(c.wram[TEAM_FLAG]! & TEAM_BIT)) c.wram[0x0df0] = c.wram[0x0ff0] = 0;
    return r.original(c, 0xc05e3d);
  });
}
