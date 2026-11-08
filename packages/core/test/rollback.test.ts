/**
 * Rollback: two peers with their own Game, fed through a simulated network with latency and
 * jitter, must end in the same state as one run that had every input on time.
 */
import { describe, expect, it } from 'vitest';
import { Game, Rollback, checksum, padsFromScript } from '../src/index.ts';
import { hasFixture, haveRom, loadFixture, loadRom } from './fixture.ts';

/** Deterministic pads that change every few frames (directions and buttons). */
function pad(slot: number, f: number): number {
  let h = Math.imul((f >> 2) + 1, 0x9e3779b1) ^ Math.imul(slot + 7, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 12;
  return h & 0xfff0;
}

function start(seed: (g: Game) => void): Game {
  const g = new Game(loadRom());
  seed(g);
  return g;
}

/** Straight run with every input on time (none in the first `delay` frames): checksums every 60 frames and at the end. */
function reference(seed: (g: Game) => void, frames: number, delay: number): { sums: Map<number, number>; end: number } {
  const g = start(seed);
  const sums = new Map<number, number>();
  for (let f = 0; f < frames; f++) {
    if (f % 60 === 0) sums.set(f, checksum(g.m.save()));
    g.step(f < delay ? [0, 0, 0, 0] : [pad(0, f), pad(1, f), 0, 0]);
  }
  return { sums, end: checksum(g.m.save()) };
}

/** Peer p owns slot p; its input for frame t + delay leaves at tick t and lands after latency(t). */
function online(seed: (g: Game) => void, frames: number, delay: number, latency: (t: number) => number) {
  const peers = [0, 1].map(() => new Rollback(start(seed), { players: 2 }));
  const sums = peers.map(() => new Map<number, number>());
  peers.forEach((r, p) => (r.onChecksum = (f, s) => sums[p]!.set(f, s)));
  // in flight: [arrival tick, to peer, frame, pad]
  const wire: [number, number, number, number][] = [];
  for (const [p, r] of peers.entries()) {
    for (let f = 0; f < delay; f++) {
      r.addInput(p, f, 0);
      wire.push([0, 1 - p, f, 0]);
    }
  }
  let stalls = 0;
  for (let t = 0; peers.some((r) => r.frame < frames || r.confirmed < frames); t++) {
    for (const [p, r] of peers.entries()) {
      const f = t + delay;
      if (f < frames) {
        r.addInput(p, f, pad(p, f));
        wire.push([t + latency(t), 1 - p, f, pad(p, f)]);
      }
    }
    // arrivals in frame order per sender (the transport repeats until acknowledged)
    wire.sort((a, b) => a[2] - b[2]);
    for (let i = 0; i < wire.length; ) {
      const [at, to, f, v] = wire[i]!;
      if (at <= t && peers[to]!.addInput(1 - to, f, v)) wire.splice(i, 1);
      else i++;
    }
    for (const r of peers) if (r.frame < frames || r.confirmed < frames) {
      if (r.frame < frames) {
        if (!r.advance()) stalls++;
      } else r.sync(); // the last inputs arrived: correct the last predictions
    }
  }
  return { peers, sums, stalls };
}

describe.skipIf(!haveRom())('rollback', () => {
  it('restoring and re-running a frame gives the same state (snapshot into a buffer)', () => {
    const g = start((g) => g.powerOn());
    for (let f = 0; f < 200; f++) g.step([pad(0, f), 0, 0, 0]);
    const snap = new Uint8Array(g.m.stateSize);
    g.m.save(snap);
    g.step([0x8000, 0, 0, 0]);
    const want = checksum(g.m.save());
    g.m.load(snap);
    g.step([0x8000, 0, 0, 0]);
    expect(checksum(g.m.save())).toBe(want);
  });

  const cases: [string, boolean, (g: Game) => void][] = [
    ['from power-on', true, (g) => g.powerOn()],
    [
      'in a match (match1-2830-trace)',
      hasFixture('match1-2830-trace'),
      (g) => {
        const fx = loadFixture('match1-2830-trace');
        g.seed(fx.record(0), fx.cpu(0)!, fx.apu);
      },
    ],
  ];
  for (const [name, have, seed] of cases) {
    it.skipIf(!have)(`two peers with latency and jitter match a run without network, ${name}`, () => {
      const frames = 360;
      const ref = reference(seed, frames, 2);
      // 2 frames of input delay; 1-6 frames of latency, now and then 11 (stalls at the 8-frame limit)
      const { peers, sums, stalls } = online(seed, frames, 2, (t) => (t % 97 < 3 ? 11 : 1 + ((t * 7) % 6)));
      for (const [p, r] of peers.entries()) {
        expect(r.rollbacks, `peer ${p} rolled back`).toBeGreaterThan(0);
        expect(checksum(r.game.m.save()), `peer ${p} final state`).toBe(ref.end);
        expect([...sums[p]!.entries()], `peer ${p} checksums`).toEqual([...ref.sums.entries()].filter(([f]) => sums[p]!.has(f)));
        expect(sums[p]!.size).toBe(ref.sums.size);
      }
      expect(stalls).toBeGreaterThan(0);
    }, 120_000);
  }
});
