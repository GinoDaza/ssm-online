/**
 * Netplay: peers exchanging packets through a simulated relay (in order, with latency) must
 * agree on every checksum, keep their frames close (time sync), and detect a desync.
 */
import { describe, expect, it } from 'vitest';
import { Game, Netplay } from '../src/index.ts';
import { haveRom, loadRom } from './fixture.ts';

function pad(slot: number, t: number): number {
  let h = Math.imul((t >> 3) + 1, 0x9e3779b1) ^ Math.imul(slot + 3, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return (h ^ (h >>> 12)) & 0xfff0;
}

interface Run {
  peers: Netplay[];
  sums: Map<number, number>[];
}

/**
 * Peer p starts at tick starts[p]; a message sent at tick t reaches the others at tick
 * t + latency(t) but never before the one sent earlier (a TCP relay).
 */
function play(players: number, ticks: number, starts: number[], latency: (t: number) => number, corrupt?: (t: number, peers: Netplay[]) => void): Run {
  const peers = Array.from({ length: players }, (_, slot) => {
    const g = new Game(loadRom());
    g.powerOn();
    return new Netplay(g, { players, slot, delay: 2, checksumEvery: 30 });
  });
  const sums = peers.map(() => new Map<number, number>());
  const wire: { at: number; to: number; data: Uint8Array }[] = [];
  const lastAt = new Int32Array(players * players);
  let t = 0;
  for (const [p, n] of peers.entries()) {
    const onChecksum = n.session.onChecksum!;
    n.session.onChecksum = (f, s) => {
      sums[p]!.set(f, s);
      onChecksum(f, s);
    };
    n.send = (data) => {
      for (let q = 0; q < players; q++) {
        if (q === p) continue;
        const at = Math.max(t + latency(t), lastAt[p * players + q]!);
        lastAt[p * players + q] = at;
        wire.push({ at, to: q, data: data.slice() });
      }
    };
  }
  for (; t < ticks; t++) {
    for (let i = 0; i < wire.length; ) {
      const m = wire[i]!;
      if (m.at <= t && t >= starts[m.to]!) {
        peers[m.to]!.receive(m.data);
        wire.splice(i, 1);
      } else i++;
    }
    for (const [p, n] of peers.entries()) if (t >= starts[p]!) n.tick(pad(p, t - starts[p]!));
    corrupt?.(t, peers);
  }
  return { peers, sums };
}

describe.skipIf(!haveRom())('netplay', () => {
  for (const players of [2, 3]) {
    it(`${players} peers agree on every checksum and keep their frames close`, () => {
      const starts = [0, 6, 3].slice(0, players);
      const { peers, sums } = play(players, 600, starts, (t) => 2 + ((t * 5) % 4));
      for (const n of peers) {
        expect(n.desync).toBe(-1);
        expect(n.session.rollbacks).toBeGreaterThan(0);
      }
      const common = [...sums[0]!.keys()].filter((f) => sums.every((m) => m.has(f)));
      expect(common.length).toBeGreaterThan(10);
      for (const f of common) for (const m of sums) expect(m.get(f), `frame ${f}`).toBe(sums[0]!.get(f));
      // the peer that started first gave back the frames it was ahead
      const frames = peers.map((n) => n.session.frame);
      expect(Math.max(...frames) - Math.min(...frames)).toBeLessThanOrEqual(3);
      expect(peers[0]!.skipped).toBeGreaterThan(0);
    }, 120_000);
  }

  it('detects a desync', () => {
    const { peers } = play(2, 300, [0, 0], () => 2, (t, peers) => {
      if (t === 100) peers[1]!.session.game.m.wram[0x1000]! ^= 1;
    });
    expect(peers[0]!.desync).toBeGreaterThan(90);
    expect(peers[1]!.desync).toBeGreaterThan(90);
  }, 60_000);
});
