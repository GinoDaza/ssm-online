/**
 * The multitap (snes9x MP5 in controller port 2, pads 2-5) against the oracle: a Team Battle
 * Royal with four human pads, seeded from an emulator frame, must follow the trace core to the
 * clock with the same WRAM, the game reading all four pads through the multitap. Dump (local):
 *   python3 tools/oracle/dump.py --core trace --input R-mt4team-1 --start 3300 --frames 600 --full --out fixtures/mt4team-3300-trace
 */
import { describe, expect, it } from 'vitest';
import { Game, padsFromScript } from '../src/index.ts';
import { hasFixture, haveRom, loadFixture, loadRom } from './fixture.ts';

const NAME = 'mt4team-3300-trace';

function follow(multitap: boolean): { bad: string[]; pads34: number } {
  const fx = loadFixture(NAME);
  const g = new Game(loadRom());
  g.seed(fx.record(0), fx.cpu(0)!, fx.apu);
  g.m.multitap = multitap;
  const bad: string[] = [];
  let pads34 = 0;
  for (let f = 0; f < fx.frames && bad.length < 5; f++) {
    const pads = padsFromScript(fx.pads[f] ?? 'wait');
    if (pads[2] || pads[3]) pads34++;
    g.step(pads);
    const want = fx.record(f + 1);
    const c = fx.cpu(f + 1)!;
    const m = g.m;
    let n = 0;
    for (let i = 0; i < want.length; i++) if (m.wram[i] !== want[i]) n++;
    // waiting in WAI: the emulator's pc is the WAI, ours the instruction after it
    const pc = m.waiting && c.waiting ? m.pc - 1 : m.pc;
    const at = `pc ${pc.toString(16)} line ${m.vline} clock ${m.cyc}`;
    const wantAt = `pc ${((c.pb << 16) | c.pc).toString(16)} line ${c.v} clock ${c.h}`;
    if (n) bad.push(`frame ${f + 1}: ${n} WRAM bytes differ`);
    else if (at !== wantAt) bad.push(`frame ${f + 1}: ${at}, emulator ${wantAt}`);
  }
  return { bad, pads34 };
}

describe.skipIf(!haveRom() || !hasFixture(NAME))('multitap', () => {
  it('four human pads: the match follows the trace core to the clock', () => {
    const r = follow(true);
    expect(r.pads34, 'pads 3 / 4 play in this stretch').toBeGreaterThan(100);
    expect(r.bad).toEqual([]);
  });

  it('the game detects it at power-on ($D2 = 9F at frame 301, 03 without; ssm-disasm notes)', () => {
    const d2 = (multitap: boolean) => {
      const g = new Game(loadRom());
      g.powerOn();
      g.m.multitap = multitap;
      for (let f = 0; f < 301; f++) g.step([0, 0, 0, 0, 0]);
      return g.m.wram[0xd2]!;
    };
    expect(d2(true).toString(16)).toBe('9f');
    expect(d2(false).toString(16)).toBe('3');
  });

  it('control: without the multitap the same inputs diverge', () => {
    expect(follow(false).bad.length).toBeGreaterThan(0);
  });
});
