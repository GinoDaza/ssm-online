# 2 vs 2 in the full arena

A Team Battle Royal played in the singles arena: the wrestlers can leave the ring, fight on the
floor around it, use the ringside items and lose by count-out. The team logic (partners,
targets, HUD, judge) is the original's.

- **Ruleset:** `singlesArena` (mode `team-arena`). Classic leaves the original unchanged.
- **Code:** `rules/src/full-arena.ts` (`ARENA_SITES`), `camera.ts`, `items.ts`, `arena.ts`,
  `sprites.ts`, `ropes.ts`, `countout.ts`
- **Tests:** `rules/test/team-arena.test.ts`, `team-arena-engine.test.ts`,
  `team-arena-graphics.test.ts`

## How

A team match (four wrestlers, the original team logic: partners, targets, HUD, judge) played in
the singles environment: the wide arena with the floor around the ring, the front crowd and the
apron, going out and back in, the ringside items. The game picks its environment by `$1BA0` bit
6 (team), read at about a hundred sites; all were read (`tools/disasm.ts`, `../ssm-disasm`
notes) and sorted into team logic (kept) and environment (`ARENA_SITES` in
`rules/src/full-arena.ts`, each with the reason). An environment site runs the original
instruction with the team bit hidden, so the singles path follows; singles matches are unchanged
(checked to the clock against the emulator).

Besides the sites:

- Camera (`rules/src/camera.ts`, at C11F71): the team camera frames the four wrestlers but stays
  in the narrow team arena (x 60..120, y up to 68). It keeps the team framing with the singles
  arena's limits (x 20..160, y 0..C0) and, with someone on the floor, the singles floor rule for
  y. Not the singles snap to an arena side: with four wrestlers it would drop the others from
  the picture; the team pull into the screen (C18E49) keeps everyone visible.
- Items (`rules/src/items.ts`): the team frame order lacks the singles item steps, the throw-in
  of new items (C11007) and their tick and drawing (C2032D). They run after the team parent
  through a return address in a ROM gap (C07F00), so the call chain lives on the game's stack.
- Arena objects (`rules/src/arena.ts`, at C02631): the match start creates the arena's objects
  from one of two tables; this mode creates the team set plus what only singles have (the ropes'
  scroll object 38, the side ropes 22 and their pieces 24), without the team arena's rope shake
  7C, which poses tiles into the BG maps where the singles maps have the posts.
- Speed: four wrestlers in the singles arena overrun the SNES frame (the game ran at about 60%
  outside the ring). Team matches in this mode set `Machine.overclock` = 1 at the match start:
  CPU and DMA spend half the clocks, the video timing stays.
- Sprite memory (`rules/src/sprites.ts`): sprite VRAM cannot hold both environments (the four
  team wrestlers stream into D000-FFFF, where singles keep the side-rope tiles and the item
  frames). The singles sprite tiles go to a second sprite bank, a Machine extension the original
  never uses: VMAIN bit 6 sends VRAM writes there, and OAM entries flagged in `oamxNext`
  (committed by the next OAM DMA) draw from it, with the bank's own sprite palettes (`cgramx`:
  the game's, but palette 7 keeps the items' colors, which team play gives to the fourth
  wrestler). The objects that draw singles graphics use it: items, side ropes 22 / 24, combat
  effects 3C (their floor-impact frames would otherwise show team play's letters). The flags
  stay while the arena objects exist (a paused game re-uploads the same OAM) and are cleared at
  C00369 once the pool no longer has them, so menus never inherit them. Bank-1 entries also take
  color math whatever their palette (`oamx` bit 4; the SNES gives it only to palettes 4-7), so
  the side ropes darken with the wrestlers on the result screens.
- Side ropes (`rules/src/ropes.ts`): the two side ropes 22 share one place for their shake frame
  (VRAM DC00, `$1A79`); the SNES screen never shows both, the wide one does, and the right one's
  upload would give the left one its tiles. On the wide picture the left rope's frame is copied
  to the other half of bank 1 instead (`oamx` bits 0 and 3), in singles too.
- Standing with an item (C1A569 / C1A594): team play fixes the standing pose; with an item in
  hand the singles pose selection runs, which picks the pose holding it.
- Count-out (`rules/src/countout.ts`): team play has no referee, so the count runs without one,
  with the singles rule: each clock second while someone stands outside (+152) the count `$1A60`
  goes up and shows (the singles digits banner); everyone back in resets it; at 20 the team with
  someone outside loses (COUNT OUT), both teams outside both lose (DOUBLE COUNT OUT), ending the
  round through the team referee's own path (members left = 0).
- Not in team play, so not in this mode: the referee himself (singles uses object 0C00, a
  wrestler in team play).

`rules/test/team-arena.test.ts` drives player 1 with a bot (`test/bot.ts`: goals checked against
WRAM) through a Team Battle Royal reached from power-on: classic keeps the ropes shut, the full
arena lets him out and back in with the camera on the floor, the items run, and a rollback in
such a match restores the same state.
