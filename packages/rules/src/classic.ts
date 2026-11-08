import type { Ruleset } from './ruleset.ts';

export const classicRules: Ruleset = {
  id: 'classic',
  label: 'Classic',
  fighters: 2,
  screenWidth: 256,
  canLeaveRing: (team) => !team,
};

export const classicTeamRules: Ruleset = { ...classicRules, id: 'classic-team', label: 'Classic team', fighters: 4 };
