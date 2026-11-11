/**
 * 3 vs 3 and 4 vs 4, players 5-8 (the Game Mode Select's choice in the full arena,
 * docs/changes/big-teams.md).
 */
import type { Game } from '@ssm/core';
import { installHud } from './hud.ts';
import { installOamExt } from './oamext.ts';
import { installPlayers } from './players.ts';
import { installReferee } from './referee.ts';
import { installSelect } from './select.ts';
import { chosenSize, extraChars, installTeams } from './teams.ts';

export function installBigTeams(game: Game): void {
  const r = game.runner;
  game.m.ramExt = true; // the extras' pages (slots.ts)
  installTeams(r);
  installSelect(r, chosenSize);
  installPlayers(r, chosenSize);
  installReferee(r);
  installOamExt(r);
  installHud(r, extraChars);
}
