/**
 * The menus in the wide picture (Ruleset.wideMenus), from power-on with a multitap: the title,
 * the Game Mode Select and the Team Battle Royal entry fill the 400 px with their own layers,
 * the SNES picture is their middle; classic keeps black sides.
 */
import { describe, expect, it } from 'vitest';
import { Game, HEIGHT, Renderer, WIDTH, padsFromScript } from '@ssm/core';
import { classicRules, installRules, teamArenaRules, type Ruleset } from '../src/index.ts';
import { haveRom, loadRom } from '../../core/test/fixture.ts';

/** the title at 700, the Game Mode Select at 960, 2 VS 2 chosen: the entry screen at 1100 */
const ROUTE = 'wait*650 start*4 wait*60 start*4 wait*220 right*4 wait*30 y*4 wait*400';
const SHOTS = { title: 700, modeSelect: 960, entry: 1100 } as const;

function shots(rules: Ruleset): Record<keyof typeof SHOTS, { wide: Uint16Array; narrow: Uint16Array; margin: number }> {
  const steps: string[] = [];
  for (const t of ROUTE.split(' ')) {
    const [s, n] = t.split('*');
    for (let k = 0; k < Number(n); k++) steps.push(s!);
  }
  const g = new Game(loadRom());
  installRules(g, rules);
  g.powerOn();
  g.m.multitap = true;
  const wide = new Renderer(g.m, 400);
  const narrow = new Renderer(g.m, WIDTH);
  g.m.onLine = (y) => {
    wide.line(y);
    narrow.line(y);
  };
  const out: Record<string, { wide: Uint16Array; narrow: Uint16Array; margin: number }> = {};
  const last = Math.max(...Object.values(SHOTS));
  for (let f = 0; f <= last; f++) {
    g.step(padsFromScript(steps[f] ?? 'wait').slice(0, 4));
    for (const [name, at] of Object.entries(SHOTS)) if (at === f) out[name] = { wide: wide.pixels.slice(), narrow: narrow.pixels.slice(), margin: g.m.wide };
  }
  return out as ReturnType<typeof shots>;
}

/** pixels of the two margins that are not black */
function drawnMargins(px: Uint16Array): number {
  let n = 0;
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < 72; x++) {
      if (px[y * 400 + x] !== 0) n++;
      if (px[y * 400 + 328 + x] !== 0) n++;
    }
  return n / (2 * 72 * HEIGHT);
}

describe.skipIf(!haveRom())('the menus in the wide picture', () => {
  it('full arena: the title, the Game Mode Select and the entry fill the margins', () => {
    const s = shots(teamArenaRules);
    for (const [name, shot] of Object.entries(s)) {
      expect(shot.margin, name).toBe(72);
      expect(drawnMargins(shot.wide), name).toBeGreaterThan(0.95);
      // the middle is the SNES picture
      let same = 0;
      for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) if (shot.wide[y * 400 + 72 + x] === shot.narrow[y * WIDTH + x]) same++;
      expect(same / (WIDTH * HEIGHT), name).toBe(1);
    }
    // the title's margins are its backdrop: one colour
    expect(new Set(Array.from({ length: HEIGHT }, (_, y) => s.title.wide[y * 400 + 10])).size).toBe(1);
    // the Game Mode Select's wallpaper repeats every 48 pixels, on the screen's lines too
    let wallpaper = 0;
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < 24; x++) if (s.modeSelect.wide[y * 400 + x] === s.modeSelect.wide[y * 400 + x + 48]) wallpaper++;
    expect(wallpaper).toBe(24 * HEIGHT);
  }, 120_000);

  it('classic: the menus keep black sides', () => {
    const s = shots(classicRules);
    for (const [name, shot] of Object.entries(s)) {
      expect(shot.margin, name).toBe(0);
      expect(drawnMargins(shot.wide), name).toBe(0);
    }
  }, 120_000);
});
