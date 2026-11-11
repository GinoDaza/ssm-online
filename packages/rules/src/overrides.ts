/**
 * The overrides a Ruleset needs (Runner.override, docs/architecture.md), one install per change
 * to the original (docs/changes/). Classic installs none, so the game is the original.
 *
 * Everything but the Game Mode Select builds on the full arena (singlesArena): the wide and
 * full-height picture, singles and menus in it, 3 vs 3 and 4 vs 4.
 */
import type { Game, Runner } from '@ssm/core';
import { createArenaObjects } from './arena.ts';
import { installBigTeams } from './big-teams.ts';
import { installFullArena } from './full-arena.ts';
import { installMenu } from './menu.ts';
import { Screen, installMenus, menuPicture, screenOf } from './menus.ts';
import { playersFrame } from './players.ts';
import { installSprites } from './sprites.ts';
import { chosenSize } from './teams.ts';
import { installWide, marginOf, setTall } from './wide.ts';
import { installWideSingles } from './wide-singles.ts';
import type { Ruleset } from './ruleset.ts';

export { ARENA_SITES } from './full-arena.ts';

const TEAM_FLAG = 0x1ba0;
const TEAM_BIT = 0x40;

/**
 * The match start C02631, shared by the changes: team matches get the full arena's objects and
 * more CPU (four wrestlers in the singles arena overrun the SNES frame; six or eight get four
 * times); team matches, and singles with wideSingles, get the wide and tall picture.
 */
function installMatchStart(r: Runner, rules: Ruleset): void {
  r.override(0xc02631, (c) => {
    const team = (c.wram[TEAM_FLAG]! & TEAM_BIT) !== 0;
    const picture = team || rules.wideSingles;
    c.overclock = team ? (rules.modeMenu && chosenSize(c) > 2 ? 2 : 1) : 0;
    c.wide = picture ? marginOf(rules.screenWidth) : 0;
    c.margins.fill(0); // the arena's maps go on (menus.ts)
    setTall(c, picture && rules.fullHeight);
    return team ? createArenaObjects(c) : r.original(c, 0xc02631);
  });
}

/** Register the overrides of `rules` on a game (before it runs). */
export function installRules(game: Game, rules: Ruleset): void {
  const r = game.runner;
  if (rules.singlesArena) {
    installFullArena(r); // full-arena.md
    installMatchStart(r, rules);
    installWide(r); // wide-picture.md: inert while Machine.wide is 0
    if (rules.wideSingles) installWideSingles(r); // wide-singles.md
    // the sprite banks (full-arena.md), and once a frame outside a match: players 5-8
    // (big-teams.md), the menus' picture (wide-menus.md)
    const margin = marginOf(rules.screenWidth);
    installSprites(r, (c) => {
      if (rules.modeMenu) playersFrame(c, chosenSize(c), screenOf(c) === Screen.ENTRY && c.wram[0x56] === 4);
      if (rules.wideMenus) menuPicture(c, margin);
    });
    if (rules.wideMenus || rules.modeMenu) installMenus(r); // the screen tracker (menus.ts)
  }
  // mode-menu.md; the panels take the wide picture's margins with the menus in it
  if (rules.modeMenu) installMenu(r, rules.singlesArena && rules.wideMenus ? marginOf(rules.screenWidth) >> 3 : 0);
  if (rules.modeMenu && rules.singlesArena) installBigTeams(game); // big-teams.md
}
