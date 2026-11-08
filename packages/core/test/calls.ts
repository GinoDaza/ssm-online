/**
 * Captured calls of an original routine (tools/oracle/capture.sh): the low WRAM at the call,
 * the registers, and the WRAM stores the original made, in order.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './fixture.ts';

export interface Call {
  D: number;
  DB: number;
  A: number;
  X: number;
  Y: number;
  P: number;
  ram: Uint8Array;
  /** offset, byte, offset, byte ... */
  stores: number[];
}

function dir(module: string): string {
  return resolve(ROOT, 'fixtures/calls', module);
}

export function hasCalls(module: string): boolean {
  return existsSync(dir(module)) && readdirSync(dir(module)).some((f) => f.endsWith('.calls'));
}

export function* readCalls(module: string): Generator<Call> {
  for (const f of readdirSync(dir(module)).filter((f) => f.endsWith('.calls')).sort()) {
    const b = new Uint8Array(readFileSync(resolve(dir(module), f)));
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let p = 0;
    while (p < b.length) {
      const call: Call = {
        D: dv.getUint16(p, true),
        DB: b[p + 2]!,
        A: dv.getUint16(p + 3, true),
        X: dv.getUint16(p + 5, true),
        Y: dv.getUint16(p + 7, true),
        P: dv.getUint16(p + 9, true),
        ram: b.subarray(p + 16, p + 16 + 0x2000),
        stores: [],
      };
      p += 16 + 0x2000;
      const n = dv.getUint16(p, true);
      p += 2;
      for (let k = 0; k < n; k++, p += 5) call.stores.push(dv.getUint32(p, true), b[p + 4]!);
      yield call;
    }
  }
}

/** First difference between two store logs, or null. */
export function storeDiff(want: number[], got: number[]): string | null {
  const fmt = (a?: number, v?: number) => (a === undefined ? 'nothing' : `$${a.toString(16)} = ${v!.toString(16)}`);
  for (let k = 0; k < Math.max(want.length, got.length); k += 2) {
    if (want[k] !== got[k] || want[k + 1] !== got[k + 1]) {
      return `store ${k / 2}: original ${fmt(want[k], want[k + 1])}, translated ${fmt(got[k], got[k + 1])}`;
    }
  }
  return null;
}
