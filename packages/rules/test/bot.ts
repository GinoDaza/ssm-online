/**
 * A player-1 bot for tests: goals read against the wrestler's WRAM (position, ring level), so
 * a scenario does not depend on the exact frame the match reaches a state.
 */
import { PAD, type Game } from '@ssm/core';

export type Goal =
  /** walk until within 6 (x) / 4 (depth) */
  | { kind: 'goto'; x: number; depth: number }
  /** double tap toward the ropes until on the floor (+71 = 0) */
  | { kind: 'exit'; dir: number }
  /** double tap toward the ring until back on it */
  | { kind: 'enter'; dir: number }
  | { kind: 'wait'; frames: number };

const LIMIT = 600;

export class Bot {
  private readonly g: Game;
  private readonly goals: Goal[];
  private readonly base: number;
  private i = 0;
  private t = 0;
  /** frame count at which each goal finished, or -1 when it gave up */
  readonly results: number[] = [];

  constructor(g: Game, goals: Goal[], base = 0x0800) {
    this.g = g;
    this.goals = goals;
    this.base = base;
  }

  get done(): boolean {
    return this.i >= this.goals.length;
  }

  private w16(a: number): number {
    return this.g.m.wram[a]! | (this.g.m.wram[a + 1]! << 8);
  }

  private next(ok: boolean): number {
    this.results.push(ok ? this.t : -1);
    this.i++;
    this.t = 0;
    return 0;
  }

  /** The pad of the next frame. */
  pad(): number {
    const goal = this.goals[this.i];
    if (!goal) return 0;
    const x = this.w16(this.base + 0x13);
    const depth = this.w16(this.base + 0x1b);
    const onRing = this.g.m.wram[this.base + 0x71] !== 0;
    this.t++;
    if (this.t > LIMIT && goal.kind !== 'wait') return this.next(false);
    switch (goal.kind) {
      case 'goto': {
        let p = 0;
        if (x < goal.x - 6) p |= PAD.RIGHT;
        else if (x > goal.x + 6) p |= PAD.LEFT;
        if (depth < goal.depth - 4) p |= PAD.DOWN;
        else if (depth > goal.depth + 4) p |= PAD.UP;
        return p || this.next(true);
      }
      case 'exit':
      case 'enter': {
        if (goal.kind === 'exit' ? !onRing : onRing) return this.next(true);
        const k = this.t % 40; // hold, release, tap, release, hold
        return k < 20 || (k >= 24 && k < 28) || k >= 32 ? goal.dir : 0;
      }
      case 'wait':
        return this.t >= goal.frames ? this.next(true) : 0;
    }
  }
}
