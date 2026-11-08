/**
 * Translated code against real calls of the original routine: every WRAM store (stack page
 * excluded) must match, in order.
 *   tools/oracle/capture.sh rom_c1_motion match1 F40-1 F12-4 F53-2
 */
import { describe, expect, it } from 'vitest';
import { Machine, Runner } from '../src/index.ts';
import { hasCalls, readCalls, storeDiff } from './calls.ts';
import { haveRom, loadRom } from './fixture.ts';

describe.skipIf(!haveRom() || !hasCalls('rom_c1_motion'))('translated code vs captured calls', () => {
  it('C18D22 (position integration) matches every captured call', () => {
    const runner = new Runner();
    let n = 0;
    const bad: string[] = [];
    for (const call of readCalls('rom_c1_motion')) {
      const c = new Machine(loadRom());
      c.wram.set(call.ram);
      c.a = call.A;
      c.x = call.X;
      c.y = call.Y;
      c.d = call.D;
      c.db = call.DB;
      c.setP(call.P & 0xff);
      c.e = false;
      c.s = 0x01f0;
      c.log = [];
      runner.call(c, 0xc18d22, 'jsr');
      const got: number[] = [];
      for (let k = 0; k < c.log.length; k += 2) {
        if ((c.log[k]! & 0x1ff00) !== 0x100) got.push(c.log[k]!, c.log[k + 1]!);
      }
      const diff = storeDiff(call.stores, got);
      if (diff && bad.length < 5) bad.push(`call ${n}: ${diff}`);
      n++;
    }
    expect(bad).toEqual([]);
    expect(n).toBeGreaterThan(1000);
  });
});
