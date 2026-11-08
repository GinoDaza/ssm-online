/**
 * Rollback session (GGPO-style) over one Game. Every peer runs the whole game; only pad words
 * travel. Each pad slot (0-3) is fed by one peer through addInput(), in frame order. When the
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
  /** pad slots in play (1-4): pads 0..players-1; the others hold 0 */
  players: number;
  /** the deepest rollback, in frames (default 8) */
  maxRollback?: number;
  /** frames between desync checksums (default 60) */
  checksumEvery?: number;
}

/** input history, in frames (a power of two) */
const RING = 256;

export class Rollback {
  readonly game: Game;
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
  private readonly inputs = new Uint16Array(RING * 4);
  /** pads the simulation used, per frame and slot */
  private readonly used = new Uint16Array(RING * 4);
  /** per slot: the inputs of the frames before this one are known */
  private readonly known = new Int32Array(4);
  /** snaps[f % length]: the state at the start of frame f */
  private readonly snaps: Uint8Array[];
  private readonly pads = new Uint16Array(4);
  /** earliest frame simulated with a wrong prediction (-1: none) */
  private rollbackTo = -1;
  private nextCheck = 0;

  constructor(game: Game, opts: RollbackOptions) {
    this.game = game;
    this.players = opts.players;
    this.maxRollback = opts.maxRollback ?? 8;
    this.checksumEvery = opts.checksumEvery ?? 60;
    for (let s = opts.players; s < 4; s++) this.known[s] = 0x7fffffff;
    this.snaps = Array.from({ length: this.maxRollback + 1 }, () => new Uint8Array(game.m.stateSize));
  }

  /** Frames before this one have the inputs of every slot. */
  get confirmed(): number {
    let c = this.known[0]!;
    for (let s = 1; s < this.players; s++) c = Math.min(c, this.known[s]!);
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
    const i = (frame & (RING - 1)) * 4 + slot;
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
    const base = (f & (RING - 1)) * 4;
    for (let s = 0; s < 4; s++) {
      const k = this.known[s]!;
      const pad = s >= this.players ? 0 : f < k ? this.inputs[base + s]! : k > 0 ? this.inputs[((k - 1) & (RING - 1)) * 4 + s]! : 0;
      this.used[base + s] = pad;
      this.pads[s] = pad;
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
