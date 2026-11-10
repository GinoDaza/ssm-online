/**
 * Seats: who plays which pad, numbered as people expect. A Team Battle Royal with the multitap
 * (as the client plays) puts pads 1 and 2 against pads 3 and 4 (the start places C0:B9FE with
 * `$1C88` = 0); players 5 and 7 join pad 1's team, 6 and 8 the other (players.ts). A seat is a
 * team and a place in it; players are numbered team by team (in 3 VS 3: P1-P3 against P4-P6),
 * and each seat is a session slot (Rollback: 0-3 pads 1-4, 4-7 players 5-8). A single match is
 * pad 1 against pad 2.
 *
 * The lobby seats people by these, and the team entry screen labels its boxes with these
 * numbers (menus.ts). The rest of the game (the player select's marks, the HUD) keeps the
 * pads' own numbers.
 */
import type { Machine } from '@ssm/core';
import { RULES_BYTES } from './slots.ts';

/** each team's session slots, first to last place */
export const TEAM_SLOTS = [
  [0, 1, 4, 6],
  [2, 3, 5, 7],
] as const;

/** The session slot of a team's `place` (0-based) in a match of `size` a team (1-4). */
export function seatSlot(size: number, team: number, place: number): number {
  return size === 1 ? team : TEAM_SLOTS[team]![place]!;
}

/** The player number (1-8) of session slot `slot` in a match of `size` a team, 0 if it has none. */
export function playerNumber(size: number, slot: number): number {
  for (let team = 0; team < 2; team++)
    for (let place = 0; place < size; place++) if (seatSlot(size, team, place) === slot) return team * size + place + 1;
  return 0;
}

/**
 * The team size a session starts with (the lobby's choice, 1-4): the Game Mode Select offers it
 * first (menu.ts). Set on every peer at the same point, before the game runs.
 */
export function presetTeamSize(m: Machine, size: number): void {
  m.rulesBytes[RULES_BYTES.PRESET] = size;
}

export const presetOf = (m: Machine) => m.rulesBytes[RULES_BYTES.PRESET]!;
