/**
 * Team matches in the singles arena: the singles graphics (side ropes, items) in team play's
 * sprite memory, and the wide picture.
 */
import { describe, expect, it } from 'vitest';
import { HEIGHT, PAD, Renderer, WIDTH } from '@ssm/core';
import { classicRules, teamArenaRules } from '../src/index.ts';
import { haveRom } from '../../core/test/fixture.ts';
import { teamMatch, w16 } from './team-match.ts';

describe.skipIf(!haveRom())('team matches in the singles arena: graphics', () => {
  const fight = teamMatch([0]);

  it('full arena: the side ropes are created and drawn from the second sprite bank', () => {
    const g = fight(teamArenaRules);
    const types = new Set<number>();
    for (let d = 0x1200; d < 0x1a00; d += 0x40) if (g.m.wram[d]) types.add(g.m.wram[d + 1]!);
    for (const t of [0x22, 0x24, 0x38, 0x4a]) expect(types.has(t), `pool type ${t.toString(16)}`).toBe(true);
    // the team arena's rope shake writes into the BG maps, where the singles maps have the posts
    expect(types.has(0x7c), 'no team rope shake').toBe(false);
    // the rope tiles (list 72's DC00 part) are in the bank, the team wrestlers keep VRAM D000-FFFF
    expect(g.m.objx.subarray(0x1c00, 0x2000).some((v) => v !== 0)).toBe(true);
    // and their palettes: the items' palette 7 (palette list 4: CB:FBC0), not the 4th wrestler's
    const items = Array.from({ length: 32 }, (_, i) => g.m.rom.u8(0xcbfbc0 + i));
    expect(Array.from(g.m.cgramx.subarray(0xe2, 0x100))).toEqual(items.slice(2));
    expect(Array.from(g.m.cgram.subarray(0x1e2, 0x200))).not.toEqual(items.slice(2));
    const classic = fight(classicRules);
    expect(classic.m.objx.every((v) => v === 0)).toBe(true);
    expect(classic.m.oamx.every((v) => v === 0)).toBe(true);
  }, 60_000);

  it('full arena: the wide picture (400 px) shows the sides, the SNES picture is its middle', () => {
    const g = fight(teamArenaRules);
    expect(g.m.wide).toBe(72);
    const wide = new Renderer(g.m, 400);
    const narrow = new Renderer(g.m, WIDTH);
    g.m.onLine = (y) => {
      wide.line(y);
      narrow.line(y);
    };
    for (let f = 0; f < 120; f++) g.step([PAD.LEFT, 0, 0, 0]);
    const x = w16(g, 0x1a84);
    expect(x).toBeGreaterThanOrEqual(0x20 + 72);
    expect(x).toBeLessThanOrEqual(0x160 - 72);
    // the sides are drawn (the arena, not black), and pieces beyond the 256 carry their real x
    const side = Array.from({ length: HEIGHT }, (_, y) => wide.pixels[y * 400 + 10]!);
    expect(side.filter((p) => p !== 0).length).toBeGreaterThan(HEIGHT / 2);
    expect(Array.from(g.m.oamx).some((v) => (v & 2) !== 0)).toBe(true);
    // BG1 / BG2 / BG3 of the middle are the SNES picture where no sprite reaches the sides
    let same = 0;
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) if (wide.pixels[y * 400 + 72 + x] === narrow.pixels[y * WIDTH + x]) same++;
    expect(same / (WIDTH * HEIGHT)).toBeGreaterThan(0.95);
  }, 60_000);

  it('a 400 px renderer shows a classic match as the SNES picture between black sides', () => {
    const g = fight(classicRules);
    const wide = new Renderer(g.m, 400);
    const narrow = new Renderer(g.m, WIDTH);
    g.m.onLine = (y) => {
      wide.line(y);
      narrow.line(y);
    };
    g.step([0, 0, 0, 0]);
    for (let y = 0; y < HEIGHT; y++) {
      expect(Array.from(wide.pixels.subarray(y * 400 + 72, y * 400 + 72 + WIDTH))).toEqual(Array.from(narrow.pixels.subarray(y * WIDTH, (y + 1) * WIDTH)));
      expect(wide.pixels[y * 400]).toBe(0);
    }
  }, 60_000);
});
