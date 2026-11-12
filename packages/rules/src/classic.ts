import type { Ruleset } from './ruleset.ts';

/** The original game, but two levels harder by default (difficulty.md). */
export const classicRules: Ruleset = {
  id: 'classic',
  label: 'Classic',
  singlesArena: false,
  screenWidth: 256,
  fullHeight: false,
  wideSingles: false,
  modeMenu: false,
  wideMenus: false,
  difficulty: 5,
};
