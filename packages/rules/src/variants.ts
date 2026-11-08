import type { Ruleset } from './ruleset.ts';
import { classicTeamRules } from './classic.ts';

/** 2vs2 where fighters may leave the ring, as in singles. */
export const teamRingOutRules: Ruleset = { ...classicTeamRules, id: 'team-ring-out', canLeaveRing: () => true };

/** 4vs4: eight fighters on a wider ring. */
export const fourVsFourRules: Ruleset = { ...teamRingOutRules, id: 'four-vs-four', fighters: 8, screenWidth: 384 };
