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
