# Singles in the wide picture

A Single Match gets the same wide, full-height picture and camera as the team matches of the
mode.

- **Ruleset:** `wideSingles`. Classic leaves the original unchanged.
- **Code:** `rules/src/wide-singles.ts` (C1B90B, C05E1D), `rules/src/camera.ts`
  (`singlesWideCamera`); the match start C02631 in `overrides.ts`
- **Tests:** `rules/test/singles-wide.test.ts`

## How

A Single Match in this mode gets the same wide, full-height picture (set at C02631 like a team
match's, without the overclock or the team arena objects) and the same camera: C1B90B
(`camera.ts` singlesWideCamera) frames the two wrestlers with the full arena's team rule
([full-arena.md](full-arena.md)) instead of the singles one (the pushing wrestler at the SNES
screen's margins 10 / F0, the snap to an arena side), then runs the original tail C1BB43 (shake,
smoothing). With the multitap (more than two pads, `$7A`) the original shows PRESS / START at
the bottom for a challenger on pads 3-4 (HUD jobs of objects 2-3, C05E1D); this mode leaves them
out, the top HUD already shows them. Everything else in a singles match is the original
(`rules/test/singles-wide.test.ts`).
