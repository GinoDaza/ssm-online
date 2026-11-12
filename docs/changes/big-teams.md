# 3 vs 3 and 4 vs 4, players 5-8

Teams of three or four wrestlers in the full arena, chosen on the Game Mode Select (3 VS 3 / 4
VS 4). The extra wrestlers are played by players 5-8 or by the CPU.

- **Ruleset:** `singlesArena` with `modeMenu` (the team size is the menu's choice). Classic
  leaves the original unchanged.
- **Code:** `rules/src/big-teams.ts` (the install), `teams.ts`, `players.ts`, `select.ts`,
  `slots.ts`, `referee.ts`, `sprites.ts`, `oamext.ts`, `hud.ts`, `seats.ts`
- **Tests:** `rules/test/big-teams.test.ts`, `players.test.ts`, `select.test.ts`,
  `seats.test.ts`

## How

A Team Battle Royal with one or two more wrestlers a team, run by the original team engine. The
players pick the four wrestlers of the original selection (up to four humans, pads 1-4); the
extras are players 5-8's or the CPU's. The team size is set at the match start (C189BC) in
`Machine.rulesWord`.

- Players 5-8 (`players.ts`): their pads are a Machine extension (`Machine.padsx`, Game.step's
  words 5-8, slots 4-7 of a rollback session). Player 5 + e plays extra e (5P and 7P with pad
  1's team). They join with START on the Team Battle Royal entry (shown for 3 VS 3 / 4 VS 4 even
  with four humans, C03197), pick their extra's character in the player select's margins (left /
  right, a confirm button; the selection waits for them, C038BA) and play it: the extra's +77
  (the pad number; 0 = the CPU) is 5-8, and the input gate's read of pad +77 (C110E9, the held
  and new words +91 / +93) takes their pad, with pad 1's button assignment
  (`rules/test/players.test.ts`).

- Picking the extras (`select.ts`): on the team player select a human whose team has a CPU
  partner picks it last: the first confirmations (C03A71, which ends the partner pick) go to the
  team's extras (`Machine.rulesBytes`, kept until the next selection: the result screens use ext
  WRAM), the cursor moving on to the next free character. Cursors and the CPU's wrestlers (taken
  from the stage's list at the VS screen, C04226) skip the picks; the picked names show in the
  margins, in the screen's font (`menus.ts`), and each picked portrait keeps the picker's
  "1P COM" marker (C20A42 follows only the partner's cursor: when it adds itself to the draw
  list, C20AC9, a copy of it in ext WRAM 6200-62FF goes there too at each pick's x). Only the cursor's
  marker blinks: the copies use sprite palette 0, unused on that screen, kept as palette 1 with
  the marker's colour steady. Sides
  nobody picks for get the first free characters (`rules/test/select.test.ts`).

- Memory (`slots.ts`): low WRAM (0000-1FFF, where the wrestlers' pages 0800-0FFF are, run with D
  = the page) is full. `Machine.ramExt` maps 6000-7FFF of banks 00-3F / 80-BF (unmapped on this
  cartridge) to WRAM 7E:6000-7FFF, which the game leaves alone from the menus to the end of a
  match (the result and continue screens use it as a buffer), so the extras' pages are 6800-6E00
  (slot numbers 4-7, wrestler numbers 5-8) and the mode's state of a match is at 7E:6400.
- The team engine reaches its wrestlers by loops over four pages (D or X from 0800 by 200, a
  count of 4): each loop gets its count and its step (after 0E00 the extras) through two small
  overrides: the match start (C189BC: the extras' characters, places, sides and opponents), the
  team frame (C11BD3: input, AI and targets, motion, pair resolution, partner follow, the
  camera's stats), the contact root (C1A9C7), the object loop (C12299), the walk-in (C1F0F9),
  the ring shake (C216CB). The contact pairs (each wrestler of a team against each of the other:
  4 in the original, a table at 1A9C) are built for 9 / 16, and the scripts hits ask for (+187)
  run for the extras too, through a return address in a ROM gap (the reaction states wait on
  them: without its script, an extra hit while lying (8A / 8C) never got up); then +141 is
  cleared for every wrestler.
- Pointers between wrestlers: +A5 the partner, +A7 / +A9 the current and previous opponent (a
  hit makes each the other's current one), +F0 / +F2 the two opponents a human's target choice
  ranks. With three or four opponents, +F0 / +F2 are the two nearest in play, and a partner or
  opponent who is gone (+76 = 0) is replaced, never while the wrestler pins or holds (+D0).
- The team referee (`referee.ts`): the original keeps a pin slot per wrestler in arrays of four
  and turns wrestler numbers 1-4 into pages; it is ported to TypeScript for eight, with its rule
  (counts, falls, releases, holds, members left, round end, no contest, time over) and the
  original's two counters (the pin-count marks read them). The time-over sums (C10E6E) and the
  judge on the counted bars (C10D3B) take every member; the judge of C11BD3 too.
- Graphics (`sprites.ts`): each extra mirrors a base slot (its tile base +05 and palette), in a
  third sprite bank (Machine extension: `objx` bank 2, VMAIN bit 5, `oamx` bit 2, its own
  palettes in `cgramx`). Its frame requests are taken when the IRQ builds the DMA list (C00971,
  mid-picture) and copied from the ROM to bank 2 when that list runs in the vertical blank
  (C00369), with the OAM drawn for them, as the base slots' frames reach VRAM; they take no DMA
  list room. Its palette loader (C18B7D) writes bank 2's palettes 4-7, which go to `cgramx` with
  the CGRAM upload (C00282).
- More sprites (`oamext.ts`): four wrestlers already fill most of the 128 OAM entries. In these
  matches a full OAM is put aside and the pass goes on in the same buffer, which becomes a
  second OAM (`Machine.oamExt`, 128 entries drawn below the first) committed with the OAM. The
  piece in the first OAM's entry 127, which the pass tail (C1F6A6) always overwrites with its
  hidden marker, moves to the second OAM's first entry, so no wrestler loses a piece at the
  boundary.
- HUD (`hud.ts`): the team HUD has four blocks across the SNES screen; the extras' (face, name,
  life bar, as C06185 / C0607D draw them) are in HUD panels beside it, in the wide picture's
  margins (Machine extension `hudx`: BG3 map entries and 64 tiles of its own, which hold the
  extras' portrait blocks, copied from WRAM 7E:9000 when the match load copies the players').
- Speed: six or eight wrestlers get four times the CPU (`Machine.overclock` = 2).

`rules/test/big-teams.test.ts` plays both from power-on: every wrestler in and fighting, drawn
from bank 2 and the second OAM, their frames and palettes changing only in the vertical blank,
an extra hit while lying getting back down,
the HUD panels, a time over judged with the extras' life, and a rollback in a 4 vs 4 match.
