/**
 * Three humans and 4 VS 4 (menu.ts, select.ts), from power-on with a multitap: pads 2 and 3
 * join on the Game Mode Select, which still offers the choice (the original skips it for
 * three or four); pad 3 alone on side 1 picks that side's extras and then its partner, shown
 * by name in the right margin; side 0 (pads 1 and 2, no partner) has its extras picked by
 * pad 1 in the left margin once its own wrestler is in (players.ts); nobody shares a
 * character. Pad 3's marker stays on its picks, and the four portraits show in the margins;
 * the VS screen shows all four extras.
 */
import { describe, expect, it } from 'vitest';
import { Game, HUDX_COLS, HUDX_ROWS, padsFromScript } from '@ssm/core';
import { installRules, teamArenaRules } from '../src/index.ts';
import { chosenTeamSize } from '../src/menu.ts';
import { cursorCharacter, picks } from '../src/select.ts';
import { SHOWN, vsCharacters } from '../src/portraits.ts';
import { BASE, EXTRA } from '../src/slots.ts';
import { haveRom, loadRom } from '../../core/test/fixture.ts';

const steps = (s: string) =>
  s.split(' ').flatMap((t) => {
    const [step, n] = t.split('*');
    return Array<string>(Number(n)).fill(step!);
  });
/** to the Game Mode Select, pads 2 and 3 join, 4 VS 4 (ssm-disasm inputs/R-mt3team-1.txt) */
const MENU = steps('wait*649 start*4 wait*60 start*4 wait*220 2start*4 wait*30 3start*4 wait*30 right*4 wait*30 right*4 wait*30 right*4 wait*60 y*4');
/** from the player select: each picks, pad 1 its side's two extras, pad 3 two extras and its partner */
const SELECT = steps('wait*80 y*4 wait*30 2y*4 wait*30 y*4 wait*30 right*4 wait*20 y*4 wait*30 3y*4 wait*40 3right*4 wait*20 3y*4 wait*40 3right*4 wait*20 3y*4 wait*40 3y*4');

/** A panel's text in the select screen's font (top tiles), row by row. */
function panelText(g: Game, panel: number): string[] {
  const font: Record<number, string> = {};
  [0x17, 0x19, 0x1b, 0x23, 0x25, 0x28, 0x2a].forEach((t, k) => (font[t] = String.fromCharCode(0x41 + k)));
  for (let k = 7; k < 26; k++) font[0x60 + 2 * (k - 7)] = String.fromCharCode(0x41 + k);
  const rows: string[] = [];
  for (let row = 0; row < HUDX_ROWS; row++) {
    let s = '';
    for (let col = 0; col < HUDX_COLS; col++) {
      const a = 2 * ((panel * HUDX_ROWS + row) * HUDX_COLS + col);
      s += font[(g.m.hudxMap[a]! | (g.m.hudxMap[a + 1]! << 8)) & 0x3ff] ?? '';
    }
    if (s) rows.push(s);
  }
  return rows;
}

describe.skipIf(!haveRom())('the extras picked on the player select', () => {
  it("three humans, 4 VS 4: pad 3 picks its side's two extras, pad 1 side 0's in the margin", () => {
    const g = new Game(loadRom());
    installRules(g, teamArenaRules);
    g.powerOn();
    g.m.multitap = true;
    const w = g.m.wram;
    const state = () => w[0x56]!;
    for (let f = 0; f < MENU.length || state() !== 0x0c; f++) g.step(padsFromScript(MENU[f] ?? 'wait'));
    expect(w[0x1ba4], 'three humans').toBe(3);
    expect(chosenTeamSize(g.m)).toBe(4);
    // pad 3's marker ("3P" / "COM", C20A42) stays on each extra it picked: its copies (side 1's
    // at 6280 / 62C0) are drawn at the picks' x, while it waits for the partner's confirmation
    for (const s of SELECT.slice(0, -44)) g.step(padsFromScript(s));
    const extrasX = picks(g.m, 1, 2).map((p) => g.m.rom.u8(0xc0c9f1 + p));
    expect([0x6280, 0x62c0].map((d) => g.m.wram[d + 0x07])).toEqual(extrasX);
    expect(g.m.wram[0x6280 + 0x02], 'a copy of pad 3 (2)').toBe(2);
    // they do not blink: sprite palette 0 (attribute bits 1-3), its colour 10 + pad steady
    expect(g.m.wram[0x6280 + 0x06]! & 0x0e).toBe(0);
    const colour = (i: number) => g.m.cgram[2 * i]! | (g.m.cgram[2 * i + 1]! << 8);
    const base = g.m.wram[0x6280 + 0x12]! | (g.m.wram[0x6280 + 0x13]! << 8);
    let blinked = false;
    for (let k = 0; k < 40; k++) {
      g.step([0, 0, 0, 0]);
      expect(colour(128 + 12)).toBe(base);
      blinked ||= colour(144 + 12) !== base;
    }
    expect(blinked, "the cursor's marker (palette 1) blinks").toBe(true);
    for (const s of SELECT.slice(-4)) g.step(padsFromScript(s));
    // their portraits in the margins (portraits.ts): 20 pieces each in the second OAM, extra
    // e's with palette 4 + e, side 0's at a real x left of the screen, side 1's past its 256
    expect(g.m.oamExtCount).toBe(80);
    for (let i = 0; i < 80; i++) {
      const e = Math.floor(i / 20);
      expect(g.m.oamx[128 + i]).toBe(6);
      if (e & 1) expect(g.m.oamWideX[128 + i]).toBeGreaterThanOrEqual(256);
      else expect(g.m.oamWideX[128 + i]).toBeLessThan(0);
      expect((g.m.oamExt[4 * i + 3]! >> 1) & 7).toBe(4 + e);
    }
    // they stay while the game loads the partner's portrait (frames without an OBJ pass)
    for (let k = 0; k < 60; k++) {
      g.step([0, 0, 0, 0]);
      expect(g.m.oamx[128], `frame ${k}`).toBe(6);
    }
    const side0 = picks(g.m, 0, 2);
    const side1 = picks(g.m, 1, 2);
    expect([...side0, ...side1].every((p) => p >= 0)).toBe(true);
    expect([0, 1, 2, 3].map((e) => g.m.wram[SHOWN + e])).toEqual([side0[0], side1[0], side0[1], side1[1]].map((p) => cursorCharacter(g.m, p!) + 1));
    // the margins name them (BIFF .. SCORP: the game's own names)
    const names = (side: number[]) =>
      side.map((p) => {
        let at = 0xc08a37;
        for (let k = 0; k < cursorCharacter(g.m, p); k++) at += 5 + g.m.rom.u8(at);
        return Array.from({ length: g.m.rom.u8(at) }, (_, k) => String.fromCharCode(g.m.rom.u8(at + 4 + k))).join('');
      });
    expect(panelText(g, 1)).toEqual(names(side1));
    expect(panelText(g, 0)).toEqual(names(side0));
    // the match: side 1's extras (6A00, 6E00) are pad 3's picks, side 0's pad 1's, all distinct
    // the VS screen (state 0E), wide: the backdrop (BG2) in the margins, the four extras'
    // portraits (25 pieces each) with the characters the match gives them
    for (let k = 0; k < 2400 && state() !== 0x0e; k++) g.step([0, 0, 0, 0]);
    for (let k = 0; k < 120; k++) g.step([0, 0, 0, 0]);
    expect(g.m.wide).toBe(72);
    expect(g.m.oamExtCount).toBe(100);
    const bg2 = (g.m.ioreg[0x08]! & 0xfc) << 9;
    const entry = (row: number, col: number) => g.m.vram[bg2 + ((col & 32) << 6) + 2 * (32 * row + (col & 31))];
    expect([entry(10, 63), entry(10, 32), entry(25, 63), entry(25, 32)]).toEqual([entry(10, 0), entry(10, 31), entry(25, 0), entry(25, 31)]);
    const vs = vsCharacters(g.m);
    for (let k = 0; k < 2400 && state() !== 0x1a; k++) g.step([0, 0, 0, 0]);
    for (let k = 0; k < 10; k++) g.step([0, 0, 0, 0]);
    expect([w[EXTRA[1] + 0x01], w[EXTRA[3] + 0x01]]).toEqual(side1.map((p) => cursorCharacter(g.m, p)));
    expect([w[EXTRA[0] + 0x01], w[EXTRA[2] + 0x01]]).toEqual(side0.map((p) => cursorCharacter(g.m, p)));
    expect(EXTRA.map((p) => w[p + 0x01])).toEqual(vs);
    const all = [...BASE, ...EXTRA].map((p) => w[p + 0x01]);
    expect(new Set(all).size).toBe(8);
    for (const p of [...BASE, ...EXTRA]) expect(w[p]! & 0x80, p.toString(16)).toBe(0x80);
  }, 120_000);
});
