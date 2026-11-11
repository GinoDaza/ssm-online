# Full-height picture

Matches fill the 224 lines of the screen instead of the original's 184 between black bands, with
the HUD moved to the new edges.

- **Ruleset:** `fullHeight`. Classic leaves the original unchanged.
- **Code:** `rules/src/wide.ts` (`setTall`), `rules/src/camera.ts` (tallY); `Machine.tall`,
  `hudTop` / `hudLift` / `hudBottom` / `hudDrop`
- **Tests:** `rules/test/team-arena-graphics.test.ts`, `singles-wide.test.ts`

## How

Originally a match shows lines 31-214, with forced blank around them; the renderer fills the 224
lines with that picture (the lines above with the state of line 31, those below with that of
line 214, before the upload IRQ at 215), and the camera y stays at 31 or more so the top shows
no more than the original's did. The HUD (BG3: faces, names and bars in lines 31-62, the clock
in 201-214) moves to the new edges, 23 lines up and 6 down (`Machine.hudTop` / `hudLift` /
`hudBottom` / `hudDrop`). The camera y has one rule on the ring and the floor (`camera.ts`
tallY): the middle of the wrestlers' feet lines at line BC, the front one at C8 at most and the
back one at 58 at least, gliding 1-4 lines a frame, instead of the ring rule (front feet near
D8) that jumped to the floor margins. The front limit holds at once: the floor walk (C18F05)
puts a wrestler back at D0 below the target, so a higher camera would pull him toward the ring;
when they do not fit, the back one is left out at the top.
