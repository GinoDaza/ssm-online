import type { Ruleset } from './ruleset.ts';

export const classicRules: Ruleset = {
  id: 'classic',
  fighters: 2,
  screenWidth: 256,
  canLeaveRing: (team) => !team,
};

export const classicTeamRules: Ruleset = { ...classicRules, id: 'classic-team', fighters: 4 };
