# Game Mode Select with 1 VS 1 to 4 VS 4

The Game Mode Select offers four choices, 1 VS 1, 2 VS 2, 3 VS 3 and 4 VS 4, instead of SINGLE
MATCH and TEAM BATTLE ROYAL.

- **Ruleset:** `modeMenu`. Classic leaves the original unchanged.
- **Code:** `rules/src/menu.ts`
- **Tests:** `rules/test/menu.test.ts`, `rules/test/wide-menus.test.ts` (the wide panels)

## How

The original screen has two panels (SINGLE MATCH, TEAM BATTLE ROYAL) in BG1 with their backdrops
in BG2; this mode rebuilds them as four narrower panels (a window of the singles picture for 1 VS 1,
the same one of the team picture for the rest) with labels in the game's own font, and left /
right move between them. On the SNES screen the windows are 5 x 10 tiles; with the menus in
the wide picture (`wideMenus`) the panels take its whole width, 12 tiles each, so the windows
are 10 x 10 of the pictures' 12 x 10 (four whole panels would need 56 columns of the 50). The
panels past the SNES screen go in the second half of the 64-column BG1 / BG2 maps, empty on
this screen and cleared by the game when it leaves. Every grey panel uses the game's own grey
palette (whichever of palettes 2 / 4 the list made grey), and the panels follow the palette
list loaded rather than the team bit, which the list follows a frame late: no flash between
1 VS 1 and 2 VS 2. The choice is kept in `Machine.rulesWord` (a word the modes own, saved with the
state); 2 VS 2 and up set the team bit. With three or four humans the original skips the choice
(team play after a wait); here they choose too, from 2 VS 2 up. Classic keeps the original
screen (`rules/test/menu.test.ts`).
