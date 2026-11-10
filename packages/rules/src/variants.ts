import type { Ruleset } from './ruleset.ts';
import { classicRules } from './classic.ts';

/**
 * 2 vs 2 in the singles arena: out of the ring, on the floor, with the ringside items; singles
 * and team matches in the wide, full-height picture.
 */
export const teamArenaRules: Ruleset = { ...classicRules, id: 'team-arena', label: 'Full arena, wide screen', singlesArena: true, screenWidth: 400, fullHeight: true, wideSingles: true, modeMenu: true };

/** 4 vs 4: eight fighters on a wider ring (not built yet). */
export const fourVsFourRules: Ruleset = { ...teamArenaRules, id: 'four-vs-four', label: '4 vs 4', fighters: 8, screenWidth: 384 };

/** The modes a room can pick (the game's own menus still choose singles or team). */
export const PLAYABLE_RULES: readonly Ruleset[] = [classicRules, teamArenaRules];

export function rulesById(id: string): Ruleset {
  return PLAYABLE_RULES.find((r) => r.id === id) ?? classicRules;
}
