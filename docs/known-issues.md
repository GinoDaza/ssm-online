# Known issues

Bugs that are understood but not fixed yet, with their cause and the planned fix.

## 2 vs 2 in the full arena

- **Results screen: the side ropes stay bright.** The results screen darkens the picture with
  color math (subtracting the fixed color), and the SNES never applies color math to sprites
  with palettes 0-3. The team wrestlers use palettes 4-7 and darken; the objects drawn from the
  second sprite bank (side ropes, apron edges, items: `sprites.ts`) use palettes 0 and 1 and do
  not. Fix: in `render.ts` (`compose`), treat second-bank sprites as color-math sprites. During
  play the fixed color is 0, so only the results screen (and any flash) changes. Not checked:
  whether the singles results screen shows the same in the original.

## 3 vs 3 and 4 vs 4

- **The extra wrestlers' sprites flicker and look slightly wrong** (seen in play; it works, but
  not cleanly). Not investigated yet. Places to check: the second OAM (`oamext.ts`: the pass
  goes on after the first fills, so which pieces land in which OAM can change from frame to
  frame), the bank-2 tiles (`sprites.ts` `extraTiles`: the direct ROM copy may lag or skip an
  animation frame's upload) and the bank-2 palettes / priorities against the base wrestlers.
- **Extras nobody picks get the first free characters**: a CPU extra's character is picked by
  the human who picks the team's CPU partner (`select.ts`); a side with two humans in pads 1-4
  has no such human, so its CPU extras get the first characters nobody has.
- **Players 5-8 play with pad 1's button assignment** (the options set pads 1-4's), and their
  joining and picking make no sound.
- **Player numbers differ between the entry screen and the rest of the game.** The lobby and
  the team entry number players team by team (`seats.ts`: P1-P3 against P4-P6 in 3 VS 3); the
  player select's marks, the HUD and the result screens keep the pads' numbers (pad 3 is 3P
  there, P4 in the lobby of a 3 VS 3).
- **The time-over count-up on the result screen shows the four base wrestlers' bars only**
  (C05B27 counts first members, then second). The judge adds the extras' bars, so the result is
  right; the count does not show them.
- **At most two pins are counted at the same time**: the original referee has two counters (the
  pin-count marks C21F84 read them); a third pin waits until one is free.
- **A give-up does not show the given-up wrestler's name** (the hold queue's display, C10EAF /
  C008D6, is left out of the ported referee).
- **5P-8P cannot join yet**: the team entry shows their boxes (PRESS START), but the console
  has four pads (the multitap's), so the extras stay the CPU's. Next: pads 5-8 for the online
  players, and the extras' `+77` pad numbers.
- **No off-screen arrows for the extras**: the arena creates one arrow object (4A) per base
  wrestler.

## 1 vs 1 in the full arena

- **The PRESS / START labels at the bottom are split.** In a wide singles match the 2P labels
  under each life bar (BG3, blinking PRESS / START) show a sliver of their top above the
  whole word. Likely cause, not checked: the full-height picture moves the bottom HUD band
  down from line `HUD_BOTTOM` (201, `wide.ts`), measured on the team HUD; the singles labels
  start above that line, so their top rows stay and the rest drops 6 lines. Fix: take the
  band's start from the singles HUD too (or move whole BG3 rows), then check both HUDs.

## Possibly the original's

- **Left side ropes: broken pieces while they shake.** When a wrestler hits the ropes on either
  side, the whole ring shakes and both side ropes keep shaking for a few frames. Only the
  left side ropes then show it wrong: short red, white and blue fragments come loose from the
  ropes (by the lowest turnbuckle, and along the ropes), and some stay there while the game is
  paused. The right side looks right. Seen in 1 vs 1 in the full arena, wide picture.
  Plausible: the original draws it too (the side ropes are sprite pieces, objects 22 / 24).
  Also possible, ours: on the wide picture the left side ropes lie left of the SNES screen, so
  their pieces go through the wide sprite x (`oamWideX`, `wide.ts`), and the shake moves them
  across that edge. Not checked against the emulator (a classic match: does the left side
  break while it shakes?). Visual only.
