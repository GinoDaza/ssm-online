/**
 * Rollback session (GGPO-style) over one Game. Every peer runs the whole game; only pad words
 * travel. Each pad slot (0-7: pads 1-4, then players 5-8, Machine.padsx) is fed by one peer
 * through addInput(), in frame order. When the
 * session simulates a frame whose input for a slot has not arrived, it predicts it (the slot's
 * last known pad). When the real input arrives and differs from what was used, the next
 * advance() restores the snapshot of that frame and re-simulates up to the present.
 *
 * The session never runs more than `maxRollback` frames ahead of the confirmed inputs (all
 * slots known): advance() then stalls and returns false. Snapshots of the last frames live in
 * preallocated buffers, so a frame allocates nothing.
 *
 * Input delay and transport belong to the host: it adds its local input for a later frame
 * (frame + delay) and sends it to the other peers, repeating what they have not acknowledged.
 * Re-simulated frames were already shown and heard: onResim lets the host detach the renderer
 * and the sound around them. onChecksum reports the checksum of the state at the start of
 * every `checksumEvery`-th frame once it is final, for the host to compare across peers.
 */
import type { Game } from '../cpu/game.ts';
import { checksum } from '../cpu/machine.ts';

export interface RollbackOptions {
  /** pad slots in play (1-8): slots 0..players-1; the others hold 0 */
  players?: number;
  /** or the slots in play, in any order and with gaps (one peer each): the others hold 0 */
  slots?: readonly number[];
  /** the deepest rollback, in frames (default 8) */
  maxRollback?: number;
  /** frames between desync checksums (default 60) */
  checksumEvery?: number;
}

/** input history, in frames (a power of two) */
const RING = 256;
/** pad slots: pads 1-4, players 5-8 */
export const SLOTS = 8;
/** the word of Game.step a slot fills: pads 1-4, then (after pad 5) players 5-8 */
const STEP_WORD = [0, 1, 2, 3, 5, 6, 7, 8] as const;

/** The slots in play of a session's options: `slots`, or 0..players-1. */
export function slotsOf(opts: { players?: number; slots?: readonly number[] }): number[] {
  const slots = opts.slots ? [...new Set(opts.slots)].sort((a, b) => a - b) : Array.from({ length: opts.players ?? 0 }, (_, s) => s);
  if (slots.length < 1 || slots.some((s) => s < 0 || s >= SLOTS || !Number.isInteger(s))) throw new Error(`slots in play: 1-${SLOTS} of 0-${SLOTS - 1}`);
  return slots;
}

export class Rollback {
  readonly game: Game;
  /** the slots in play (ascending) and how many */
  readonly slots: readonly number[];
  readonly players: number;
  readonly maxRollback: number;
  readonly checksumEvery: number;
  /** the next frame to simulate (frames since the session started) */
  frame = 0;
  /** rollbacks done and frames re-simulated (statistics) */
  rollbacks = 0;
  resimulated = 0;
  /** called with true before re-simulating frames and false after */
  onResim: ((active: boolean) => void) | null = null;
  /** checksum of the state at the start of `frame`, once that state is final */
  onChecksum: ((frame: number, sum: number) => void) | null = null;

  /** pads received, per frame and slot */
  private readonly inputs = new Uint16Array(RING * SLOTS);
  /** pads the simulation used, per frame and slot */
  private readonly used = new Uint16Array(RING * SLOTS);
  /** per slot: the inputs of the frames before this one are known */
  private readonly known = new Int32Array(SLOTS);
  private readonly inPlay = new Uint8Array(SLOTS);
  /** snaps[f % length]: the state at the start of frame f */
  private readonly snaps: Uint8Array[];
  private readonly pads = new Uint16Array(9);
  /** earliest frame simulated with a wrong prediction (-1: none) */
  private rollbackTo = -1;
  private nextCheck = 0;

  constructor(game: Game, opts: RollbackOptions) {
    this.game = game;
    this.slots = slotsOf(opts);
    this.players = this.slots.length;
    this.maxRollback = opts.maxRollback ?? 8;
    this.checksumEvery = opts.checksumEvery ?? 60;
    for (const s of this.slots) this.inPlay[s] = 1;
    for (let s = 0; s < SLOTS; s++) if (!this.inPlay[s]) this.known[s] = 0x7fffffff;
    this.snaps = Array.from({ length: this.maxRollback + 1 }, () => new Uint8Array(game.m.stateSize));
  }

  /** Frames before this one have the inputs of every slot. */
  get confirmed(): number {
    let c = 0x7fffffff;
    for (const s of this.slots) c = Math.min(c, this.known[s]!);
    return c;
  }

  /** The first frame whose input for `slot` is still missing. */
  knownFor(slot: number): number {
    return this.known[slot]!;
  }

  /**
   * The pad of `slot` for `frame`. Inputs come in frame order: a frame already known is
   * ignored (repeats); a gap returns false and the input is not taken.
   */
  addInput(slot: number, frame: number, pad: number): boolean {
    const k = this.known[slot]!;
    if (frame < k) return true;
    if (frame > k) return false;
    if (frame - this.frame >= RING - this.maxRollback - 1) throw new Error(`input for frame ${frame} too far ahead`);
    const i = (frame & (RING - 1)) * SLOTS + slot;
    this.inputs[i] = pad;
    this.known[slot] = frame + 1;
    if (frame < this.frame && this.used[i] !== pad && (this.rollbackTo < 0 || frame < this.rollbackTo)) {
      this.rollbackTo = frame;
    }
    return true;
  }

  /**
   * Correct any wrong prediction, then simulate the next frame. Returns false (nothing run)
   * when the session is `maxRollback` frames ahead of the confirmed inputs.
   */
  advance(): boolean {
    this.sync();
    const ok = this.frame - this.confirmed < this.maxRollback;
    if (ok) this.run(this.frame++);
    this.reportChecksums();
    return ok;
  }

  /** Correct the wrong predictions: re-simulate from the first one up to the present. */
  sync(): void {
    if (this.rollbackTo < 0) return;
    const from = this.rollbackTo;
    this.rollbackTo = -1;
    this.game.m.load(this.snaps[from % this.snaps.length]!);
    this.rollbacks++;
    this.resimulated += this.frame - from;
    this.onResim?.(true);
    for (let f = from; f < this.frame; f++) this.run(f);
    this.onResim?.(false);
    this.reportChecksums();
  }

  private run(f: number): void {
    const base = (f & (RING - 1)) * SLOTS;
    for (let s = 0; s < SLOTS; s++) {
      const k = this.known[s]!;
      const pad = !this.inPlay[s] ? 0 : f < k ? this.inputs[base + s]! : k > 0 ? this.inputs[((k - 1) & (RING - 1)) * SLOTS + s]! : 0;
      this.used[base + s] = pad;
      this.pads[STEP_WORD[s]!] = pad;
    }
    this.game.m.save(this.snaps[f % this.snaps.length]);
    this.game.step(this.pads);
  }

  private reportChecksums(): void {
    const last = Math.min(this.confirmed, this.frame);
    while (this.nextCheck <= last) {
      const f = this.nextCheck;
      this.nextCheck += this.checksumEvery;
      if (!this.onChecksum) continue;
      if (f === this.frame) this.onChecksum(f, checksum(this.game.m.save(this.snaps[f % this.snaps.length])));
      else if (this.frame - f < this.snaps.length) this.onChecksum(f, checksum(this.snaps[f % this.snaps.length]!));
    }
  }
}
