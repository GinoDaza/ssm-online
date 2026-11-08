/**
 * The overrides a Ruleset needs (Runner.override, docs/architecture.md). Classic installs
 * none, so the game is the original.
 *
 * Team matches in the singles arena (Ruleset.singlesArena). The game picks between its two
 * environments by `$1BA0` bit 6 (team), read in about a hundred places. Most of them choose
 * team logic (four wrestlers, partners and targets, HUD, judge, selection screens) and stay.
 * The sites listed in ARENA_SITES choose the environment instead: they run the original
 * instruction with the team bit hidden, so the singles path follows.
 */
import type { Game, Machine, Runner } from '@ssm/core';
import { teamArenaCamera } from './camera.ts';
import { installItems } from './items.ts';
import type { Ruleset } from './ruleset.ts';

const TEAM_FLAG = 0x1ba0;
const TEAM_BIT = 0x40;

interface Site {
  /** the instruction that reads `$1BA0` (or the word `$1B9F`) */
  pc: number;
  /** its length in bytes */
  len: number;
  /** what the singles path does there */
  why: string;
  /**
   * `LDA $1B9F; BVS`: an original bug, LDA does not set V, so the branch follows the V the
   * caller left (in team play usually set by an earlier BIT of the flag, in singles clear).
   * The singles path needs V clear after the load.
   */
  clearV?: boolean;
  /** only then (else the team path): for team choices that the singles environment extends */
  when?: (c: Machine) => boolean;
}

/** The current target (+A7, in X at the site) is off the ring: on the floor or beside the apron. */
const targetOutside = (c: Machine) => {
  const side = c.wram[c.x + 0x6f]! | (c.wram[c.x + 0x70]! << 8); // a wrestler page, 0800-0FFF
  return (side & 0x8001) !== 0 && side !== 0x7f7f;
};

/** Environment choices: these run as in singles. */
export const ARENA_SITES: readonly Site[] = [
  // arena graphics, before the match (C01FB8)
  { pc: 0xc01fd1, len: 3, why: 'arena tiles C0:A030[venue] and VRAM list 72 (team: A039, 73)' },
  { pc: 0xc0268f, len: 4, why: 'arena palette 5 (team: replaced by the tag palette)' },
  // match start (C02029)
  { pc: 0xc02075, len: 3, why: 'ringside items C18BBF and arena map WRAM list 37 (team: 40, no floor)' },
  // the rope / floor state 2C (C13750: a double tap toward the ropes)
  { pc: 0xc13817, len: 3, why: 'on the ring: through the ropes, states 28 / 2A (team: bounce, C13836)' },
  { pc: 0xc13766, len: 3, why: 'on the floor: climb back in, state 2E (team: the ring path)' },
  // character moves against an opponent outside or beside the apron
  { pc: 0xc19faa, len: 3, why: 'rope dive test C19FA8 (team: never)' },
  { pc: 0xc1a083, len: 3, why: 'follow-outside test C1A07F (team: never)' },
  { pc: 0xc1572c, len: 3, why: 'a downed wrestler at the front edge holding down rolls off the apron (C1595C, state B0)' },
  { pc: 0xc157fe, len: 3, why: 'the same from the other floor state' },
  // dives from a corner (states 84 / 86): team play picks between both opponents on the ring;
  // a target outside takes the singles path, which aims the dive at his side (+B4 = his +6F)
  { pc: 0xc12df0, len: 3, why: 'corner dive 84 onto a target outside', when: targetOutside },
  { pc: 0xc12ee5, len: 3, why: 'corner dive 86 onto a target outside', when: targetOutside },
  // the CPU: its driver rolls how to react when its situation changes toward the outside
  // (team play skips the roll), and the script opcodes that take it out after a target
  { pc: 0xc15f82, len: 3, why: 'AI driver: roll on a change of situation bit 2 (team: no roll)' },
  { pc: 0xc176e9, len: 3, why: 'AI 2C: walk to the ropes toward a target beside the apron', clearV: true },
  { pc: 0xc177a9, len: 3, why: 'AI 2E: the same, then wait in state 1C' },
  { pc: 0xc177f7, len: 3, why: 'AI 30: through the ropes after a target outside (states 28 / 2A)', clearV: true },
];

/**
 * Run the instruction at `site` with the team bit hidden. Singles (bit clear) run it as it is,
 * so a singles match is the original under these rules too.
 */
function hideTeam(r: Runner, site: Site): void {
  r.split((site.pc & 0xff0000) | ((site.pc + site.len) & 0xffff));
  r.override(site.pc, (c: Machine) => {
    const flag = c.wram[TEAM_FLAG]!;
    if (!(flag & TEAM_BIT) || (site.when && !site.when(c))) return r.original(c, site.pc);
    c.wram[TEAM_FLAG] = flag & ~TEAM_BIT;
    const next = r.original(c, site.pc);
    c.wram[TEAM_FLAG] = flag;
    if (site.clearV) c.v = false;
    return next;
  });
}

/** Register the overrides of `rules` on a game (before it runs). */
export function installRules(game: Game, rules: Ruleset): void {
  const r = game.runner;
  if (rules.singlesArena) {
    for (const site of ARENA_SITES) hideTeam(r, site);
    r.override(0xc11f71, teamArenaCamera);
    installItems(r);
  }
}
