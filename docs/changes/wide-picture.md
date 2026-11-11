# Wide picture (16:9)

Matches show 400 px instead of the SNES screen's 256: more of the arena on each side.

- **Ruleset:** `screenWidth` = 400. Classic leaves the original unchanged.
- **Code:** `rules/src/wide.ts`, `rules/src/camera.ts`; the renderer `core/src/ppu/render.ts`
  (`Machine.wide`, `oamWideX`)
- **Tests:** `rules/test/team-arena-graphics.test.ts`, `singles-wide.test.ts`

## How

At 400 px (16:9; 4x is 1600 x 896) the arena (576 px) is already whole in the BG1 / BG2 maps, so
the renderer only draws more of them; `Machine.wide` (the margin, 72) is set at the match start
and cleared with the arena, so menus and singles stay 256 px between black sides. BG3 (the HUD)
stays in the middle; sprite pieces beyond the 256 carry their real x (`Machine.oamWideX`). The
game is told its screen is wider where it decides by it: the culls (x + a < b, seven sites), the
screen pull C18E49, the off-screen arrows, and the camera clamps and margins.
