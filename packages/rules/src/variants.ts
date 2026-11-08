import type { Ruleset } from './ruleset.ts';
import { classicRules, classicTeamRules } from './classic.ts';

/** 2vs2 where fighters may leave the ring, as in singles. */
export const teamRingOutRules: Ruleset = { ...classicTeamRules, id: 'team-ring-out', label: 'Ring-out in team matches', canLeaveRing: () => true };

/** 4vs4: eight fighters on a wider ring. */
export const fourVsFourRules: Ruleset = { ...teamRingOutRules, id: 'four-vs-four', label: '4 vs 4', fighters: 8, screenWidth: 384 };

/** The modes a room can pick (the original game decides singles or team). */
export const PLAYABLE_RULES: readonly Ruleset[] = [classicRules, teamRingOutRules];

export function rulesById(id: string): Ruleset {
  return PLAYABLE_RULES.find((r) => r.id === id) ?? classicRules;
}
