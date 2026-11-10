/**
 * Netplay: a Rollback session and the input exchange between peers, over any transport that
 * delivers each peer's messages in order (the server's WebSocket relay; later WebRTC data
 * channels, which may drop messages: every packet repeats what is not acknowledged).
 *
 * The host calls tick(pad) once per display frame with the local pad, gives every message it
 * receives to receive(), and sends what `send` is called with to every other peer.
 *
 * - Input delay: the pad of tick t is the input of frame t + delay (the first `delay` frames
 *   have none), so on a LAN a remote input usually arrives before its frame is simulated.
 * - Acknowledgement: each input packet carries what the sender has of every slot. A peer
 *   resends its inputs from the oldest one some other peer lacks.
 * - Time sync: each peer reports how many frames it is ahead of each other peer. When one is
 *   ahead of another by more than the other is of it (the latency cancels out), it skips a
 *   tick, at most once every SKIP_GAP ticks, so the peers that run ahead do not keep the
 *   others rolling back.
 * - Desync: the checksums of the session are sent and compared; `desync` is the first frame
 *   where a peer's state differed.
 *
 * Messages (little-endian):
 *   input     u8 1, u8 slot, i32 frame, i32 known[8], i8 advantage[8], i32 start, u8 n, u16 pad[n]
 *   checksum  u8 2, u8 slot, i32 frame, u32 sum
 */
import type { Game } from '../cpu/game.ts';
import { Rollback, SLOTS, slotsOf } from './rollback.ts';

export interface NetplayOptions {
  /** pad slots in play (2-8: pads 1-4, then players 5-8); peer k feeds slot k */
  players?: number;
  /** or the slots in play, with gaps (one peer each; the others hold 0) */
  slots?: readonly number[];
  /** the local slot */
  slot: number;
  /** frames of input delay (default 2) */
  delay?: number;
  maxRollback?: number;
  checksumEvery?: number;
}

const INPUT = 1;
const CHECKSUM = 2;
/** local input history kept for resending, in frames (a power of two) */
const HISTORY = 256;
/** most pads in one packet */
const MAX_PADS = 64;
/** fewest ticks between two skipped ticks */
const SKIP_GAP = 8;
/** input packet offsets: known[SLOTS], advantage[SLOTS], start, n, the pads */
const KNOWN = 6;
const ADVANTAGE = KNOWN + 4 * SLOTS;
const START = ADVANTAGE + SLOTS;
const COUNT = START + 4;
const PADS = COUNT + 1;

export class Netplay {
  readonly session: Rollback;
  readonly slot: number;
  readonly players: number;
  /** the slots in play */
  readonly slots: readonly number[];
  readonly delay: number;
  /** a message for every other peer */
  send: (data: Uint8Array) => void = () => {};
  /** first frame whose state differed on some peer (-1: none) */
  desync = -1;
  onDesync: ((frame: number, slot: number) => void) | null = null;
  /** ticks that did not advance: waiting for inputs, or skipped by the time sync */
  stalls = 0;
  skipped = 0;

  private readonly mine = new Uint16Array(HISTORY);
  /** per remote slot: frames of the local slot that peer has */
  private readonly acked = new Int32Array(SLOTS);
  /** per remote slot: its frame, and how far it is ahead of the local peer */
  private readonly theirFrame = new Int32Array(SLOTS);
  private readonly theirAdvantage = new Int32Array(SLOTS);
  /** own checksums not yet compared with every peer, and how many peers compared */
  private readonly sums = new Map<number, number>();
  private readonly checked = new Map<number, number>();
  /** peers' checksums of frames the local peer has not reached: frame -> [slot, sum] */
  private readonly pending = new Map<number, [number, number][]>();
  private sinceSkip = 0;

  constructor(game: Game, opts: NetplayOptions) {
    this.slot = opts.slot;
    this.slots = slotsOf(opts);
    this.players = this.slots.length;
    if (!this.slots.includes(opts.slot)) throw new Error(`slot ${opts.slot} is not in play`);
    this.delay = opts.delay ?? 2;
    this.session = new Rollback(game, {
      slots: this.slots,
      ...(opts.maxRollback !== undefined && { maxRollback: opts.maxRollback }),
      ...(opts.checksumEvery !== undefined && { checksumEvery: opts.checksumEvery }),
    });
    this.session.onChecksum = (f, sum) => {
      this.sums.set(f, sum);
      const b = new Uint8Array(10);
      const dv = new DataView(b.buffer);
      dv.setUint8(0, CHECKSUM);
      dv.setUint8(1, this.slot);
      dv.setInt32(2, f, true);
      dv.setUint32(6, sum, true);
      this.send(b);
      for (const [from, theirs] of this.pending.get(f) ?? []) this.compare(f, from, theirs);
      this.pending.delete(f);
    };
  }

  /** frames the local peer is ahead of the given remote slot, by its last report */
  advantage(slot: number): number {
    return this.session.frame - this.theirFrame[slot]!;
  }

  /** How many frames the local peer should give back: the most it is ahead of any other. */
  get lead(): number {
    let lead = 0;
    for (const s of this.slots) {
      if (s === this.slot) continue;
      lead = Math.max(lead, Math.trunc((this.advantage(s) - this.theirAdvantage[s]!) / 2));
    }
    return lead;
  }

  /** One display frame: take the local pad, send the inputs, advance (or wait). Returns whether a frame ran. */
  tick(pad: number): boolean {
    const s = this.session;
    while (s.knownFor(this.slot) <= s.frame + this.delay) {
      const f = s.knownFor(this.slot);
      const v = f < this.delay ? 0 : pad;
      this.mine[f & (HISTORY - 1)] = v;
      s.addInput(this.slot, f, v);
    }
    this.sendInputs();
    this.sinceSkip++;
    if (this.lead >= 1 && this.sinceSkip >= SKIP_GAP) {
      this.sinceSkip = 0;
      this.skipped++;
      s.sync();
      return false;
    }
    if (s.advance()) return true;
    this.stalls++;
    return false;
  }

  receive(data: Uint8Array): void {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const kind = dv.getUint8(0);
    const from = dv.getUint8(1);
    if (!this.slots.includes(from) || from === this.slot) return;
    if (kind === INPUT) {
      this.theirFrame[from] = dv.getInt32(2, true);
      this.acked[from] = Math.max(this.acked[from]!, dv.getInt32(KNOWN + 4 * this.slot, true));
      this.theirAdvantage[from] = dv.getInt8(ADVANTAGE + this.slot);
      const start = dv.getInt32(START, true);
      const n = dv.getUint8(COUNT);
      for (let k = 0; k < n; k++) this.session.addInput(from, start + k, dv.getUint16(PADS + 2 * k, true));
    } else if (kind === CHECKSUM) {
      const f = dv.getInt32(2, true);
      const sum = dv.getUint32(6, true);
      if (this.sums.has(f)) this.compare(f, from, sum);
      else this.pending.set(f, [...(this.pending.get(f) ?? []), [from, sum]]);
    }
  }

  private sendInputs(): void {
    const s = this.session;
    let start = s.knownFor(this.slot);
    for (const r of this.slots) if (r !== this.slot) start = Math.min(start, this.acked[r]!);
    const n = Math.min(s.knownFor(this.slot) - start, MAX_PADS);
    const b = new Uint8Array(PADS + 2 * n);
    const dv = new DataView(b.buffer);
    dv.setUint8(0, INPUT);
    dv.setUint8(1, this.slot);
    dv.setInt32(2, s.frame, true);
    for (let r = 0; r < SLOTS; r++) {
      const on = this.slots.includes(r);
      dv.setInt32(KNOWN + 4 * r, on ? s.knownFor(r) : 0, true);
      dv.setInt8(ADVANTAGE + r, on && r !== this.slot ? Math.max(-128, Math.min(127, this.advantage(r))) : 0);
    }
    dv.setInt32(START, start, true);
    dv.setUint8(COUNT, n);
    for (let k = 0; k < n; k++) dv.setUint16(PADS + 2 * k, this.mine[(start + k) & (HISTORY - 1)]!, true);
    this.send(b);
  }

  private compare(f: number, from: number, sum: number): void {
    if (sum !== this.sums.get(f) && (this.desync < 0 || f < this.desync)) {
      this.desync = f;
      this.onDesync?.(f, from);
    }
    const n = (this.checked.get(f) ?? 0) + 1;
    if (n < this.players - 1) this.checked.set(f, n);
    else {
      this.sums.delete(f);
      this.checked.delete(f);
    }
  }
}
