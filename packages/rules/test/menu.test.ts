/**
 * The Game Mode Select with 1 VS 1 .. 4 VS 4 (Ruleset.modeMenu), from power-on: left / right
 * move between the four panels, 2 VS 2 and up are a Team Battle Royal, the choice survives a
 * rollback; classic keeps the original two panels.
 */
import { describe, expect, it } from 'vitest';
import { Game, PAD, padsFromScript } from '@ssm/core';
import { chosenTeamSize, classicRules, installRules, teamArenaRules, type Ruleset } from '../src/index.ts';
import { haveRom, loadRom } from '../../core/test/fixture.ts';

/** power-on to the Game Mode Select (ssm-disasm inputs/match1.txt) */
const TO_MENU = 'wait*654 start*4 wait*60 start*4 wait*240';

function atMenu(rules: Ruleset): Game {
  const g = new Game(loadRom());
  installRules(g, rules);
  g.powerOn();
  for (const t of TO_MENU.split(' ')) {
    const [s, n] = t.split('*');
    for (let k = 0; k < Number(n); k++) g.step(padsFromScript(s!).slice(0, 4));
  }
  expect(g.m.wram[0x56], 'the Game Mode Select').toBe(4);
  return g;
}

const press = (g: Game, pad: number) => {
  for (let f = 0; f < 4; f++) g.step([pad, 0, 0, 0]);
  for (let f = 0; f < 10; f++) g.step([0, 0, 0, 0]);
};
const team = (g: Game) => (g.m.wram[0x1ba0]! & 0x40) !== 0;

/**
 * BG1 map row 18 (the labels) as text, from the font tiles 100 + character - 20; the 64-column
 * map from column -9 (55) to 40, the wide picture's 50
 */
function labels(g: Game): string {
  const base = (g.m.ioreg[0x07]! & 0xfc) << 9;
  let s = '';
  for (let k = -9; k < 41; k++) {
    const col = k & 63;
    const at = base + ((col >> 5) << 11) + (18 * 32 + (col & 31)) * 2;
    const e = g.m.vram[at]! | (g.m.vram[at + 1]! << 8);
    const t = e & 0x3ff;
    s += t >= 0x100 && t < 0x160 ? String.fromCharCode(t - 0x100 + 0x20) : ' ';
  }
  return s.trim().replace(/\s+/g, ' ');
}

describe.skipIf(!haveRom())('the Game Mode Select: 1 VS 1 to 4 VS 4', () => {
  it('full arena: four panels, left / right move, 2 VS 2 and up are team play', () => {
    const g = atMenu(teamArenaRules);
    expect(labels(g)).toBe('1 VS 1 2 VS 2 3 VS 3 4 VS 4');
    const seen: [number, boolean][] = [[chosenTeamSize(g.m), team(g)]];
    for (const pad of [PAD.RIGHT, PAD.RIGHT, PAD.RIGHT, PAD.RIGHT, PAD.LEFT, PAD.LEFT, PAD.LEFT, PAD.LEFT]) {
      press(g, pad);
      seen.push([chosenTeamSize(g.m), team(g)]);
    }
    expect(seen).toEqual([
      [1, false],
      [2, true],
      [3, true],
      [4, true],
      [4, true],
      [3, true],
      [2, true],
      [1, false],
      [1, false],
    ]);
  }, 60_000);

  it('full arena: a rollback restores the choice', () => {
    const g = atMenu(teamArenaRules);
    press(g, PAD.RIGHT);
    const snap = g.m.save();
    press(g, PAD.RIGHT);
    press(g, PAD.RIGHT);
    expect(chosenTeamSize(g.m)).toBe(4);
    g.m.load(snap);
    expect(chosenTeamSize(g.m)).toBe(2);
    press(g, PAD.RIGHT);
    expect(chosenTeamSize(g.m)).toBe(3);
  }, 60_000);

  it('full arena: 3 VS 3 goes on to the Team Battle Royal player select', () => {
    const g = atMenu(teamArenaRules);
    press(g, PAD.RIGHT);
    press(g, PAD.RIGHT);
    press(g, PAD.Y);
    for (let f = 0; f < 120; f++) g.step([0, 0, 0, 0]);
    expect(g.m.wram[0x56]).toBe(0x0c);
    expect(team(g)).toBe(true);
  }, 60_000);

  it('classic: the original two panels, left / right toggle team play', () => {
    const g = atMenu(classicRules);
    expect(labels(g)).not.toContain('VS');
    expect(team(g)).toBe(false);
    press(g, PAD.RIGHT);
    expect(team(g)).toBe(true);
    press(g, PAD.RIGHT);
    expect(team(g)).toBe(false);
    expect(g.m.rulesWord).toBe(0);
  }, 60_000);
});
