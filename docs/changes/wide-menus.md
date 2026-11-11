# Menus in the wide picture

The Game Mode Select, the Team Battle Royal entry and the player select fill the 400 px picture
with their own backgrounds; the other screens, the title among them, keep the SNES picture
between black sides.

- **Ruleset:** `wideMenus`. Classic leaves the original unchanged.
- **Code:** `rules/src/menus.ts`; `Machine.margins`, `marginTiles`, `hudx`
- **Tests:** `rules/test/wide-menus.test.ts`, `core/test/margins.test.ts` (the margins' own tiles)

## How

The screens before a match fill the same 400 x 224 picture. Their maps end at the SNES screen's
256 columns (past them is another layer's map, or nothing), so a Machine extension says what the
margins show instead (`Machine.margins`, set once a frame outside a match): per BG layer its map
as it goes on (the default, the matches), nothing, a patch of the layer as it shows on the
screen, repeated (x, width, y, height), or its map going on with tiles of the margins' own (an
8 KiB bank in the state, `Machine.marginTiles`, for screens whose VRAM is full); and sprites without a real x stay inside the 256, since
the game parks the unused ones just outside. The screen is known by the last VRAM list loaded
(C00643): the Game Mode Select (7: the wallpaper, a 48 x 32 patch; with the four panels of
`modeMenu` BG1 and BG2 go on into their maps' second halves, where the panels and wallpaper
are drawn, and BG3 is off), the Team Battle Royal entry
(6: the lights and the crowd, 64 px wide strips) and the player select (3 / 4: the portraits and
the belt on the backdrop; the belt, BG2, mirrored about the middle, goes on into the margins:
each side medallion, cut by the screen's edge, is completed by its visible part mirrored, its
inner pixel column (the middle never shows) widened 2 px (a pixel each side) so it stays round, then the strap goes
on to the picture's edge; the tiles are built pixel by pixel from the screen's own into the
margins' bank, the entries in the second half of the 64-column BG2 map). The other screens keep the SNES picture between black sides, the
title (list 2) too, whose margins would only show its backdrop colour
(`rules/test/wide-menus.test.ts`). The entry of a 3 VS 3 / 4 VS 4 also shows the extra players'
boxes (5P and 6P beside the four original ones, 7P and 8P above them) in the HUD panels of the
margins, now as tall as the screen and with eight palettes of their own (`Machine.hudxPalettes`,
a margins flag) so the new players get their own colours; a box's inside is that of an original
box still waiting for its player.
