# Changes to the original

Every way this project departs from the original game. The ROM's code runs as translated;
each change replaces routines with TypeScript overrides (`Runner.override`, see
`../architecture.md`) that read the room's `Ruleset` (`packages/rules/src/ruleset.ts`). The
classic rules install only the default difficulty, so the game is otherwise the original.

Each document says what changes, which `Ruleset` field turns it on, where it touches the ROM
and which test checks it. The details of each override are in the comments of its file in
`packages/rules/src`.

| Change | Ruleset | Document |
| --- | --- | --- |
| 2 vs 2 in the full arena: out of the ring, the floor, items, count-out | `singlesArena` | [full-arena.md](full-arena.md) |
| Wide picture, 400 px (16:9) | `screenWidth` | [wide-picture.md](wide-picture.md) |
| Full-height picture, 224 lines | `fullHeight` | [full-height.md](full-height.md) |
| Singles in the wide picture | `wideSingles` | [wide-singles.md](wide-singles.md) |
| Game Mode Select with 1 VS 1 to 4 VS 4 | `modeMenu` | [mode-menu.md](mode-menu.md) |
| Menus in the wide picture | `wideMenus` | [wide-menus.md](wide-menus.md) |
| 3 vs 3 and 4 vs 4, players 5-8 | `singlesArena` + `modeMenu` | [big-teams.md](big-teams.md) |
| Default difficulty two levels up (all modes) | `difficulty` | [difficulty.md](difficulty.md) |

The modes a room can pick are in `packages/rules/src/variants.ts`: `classic` and `team-arena`
(all of the above).

A new change gets its own document here, with the same parts: what changes, Ruleset, code,
tests, how.
