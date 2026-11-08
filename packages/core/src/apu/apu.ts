/**
 * The sound unit: the SPC700 (smp.ts) running the game's own driver from its 64 KiB RAM, and
 * the DSP (dsp.ts) that plays it. It runs behind the CPU and catches up when the CPU touches
 * its ports ($2140-$2143) and at every line end, as in the oracle (snes9x apu.cpp): master
 * clocks convert to SPC clocks at 15664 / 328125 (NTSC), the remainder carried.
 *
 * The state lives in `state` (a region of the Machine's state buffer): the SMP's RAM and
 * registers directly, the DSP copied in by save() / load().
 */
import { Dsp, DSP_STATE_WORDS } from './dsp.ts';
import { CPU_PORT, DSP_ADDR, F8, F9, IPL, ON, OC, PC, R16_SIZE, R8_SIZE, S, Smp, T0, A, X, Y, RD, WR, DP, SP, YA, BIT } from './smp.ts';

const NUM = 15664;
const DEN = 328125;

const RAM = 0;
const R8 = RAM + 0x10000;
const R16 = R8 + R8_SIZE;
const I32 = R16 + 2 * R16_SIZE;
/** SMP clock, reference time (master clocks, relative to the line), remainder */
const I32_WORDS = 4;
const DSP = I32 + 4 * I32_WORDS;
export const APU_STATE_SIZE = DSP + 4 * DSP_STATE_WORDS;

export class Apu {
  readonly state: Uint8Array;
  readonly ram: Uint8Array;
  readonly smp: Smp;
  readonly dsp: Dsp;
  private readonly t: Int32Array;
  private readonly dspState: Int32Array;

  /** `state` must start at a multiple of 4 in its buffer */
  constructor(state: Uint8Array) {
    this.state = state;
    const buf = state.buffer;
    const at = state.byteOffset;
    this.ram = state.subarray(RAM, RAM + 0x10000);
    this.t = new Int32Array(buf, at + I32, I32_WORDS);
    this.dspState = new Int32Array(buf, at + DSP, DSP_STATE_WORDS);
    this.dsp = new Dsp(this.ram);
    this.smp = new Smp(this.ram, state.subarray(R8, R8 + R8_SIZE), new Uint16Array(buf, at + R16, R16_SIZE), this.t, this.dsp);
  }

  /** Power-on: the IPL ROM runs, the DSP has its initial registers. */
  reset(): void {
    this.smp.reset();
    this.dsp.reset();
    this.t[1] = 0;
    this.t[2] = 0;
  }

  /** Run the sound unit up to the CPU's clock `cyc` (master clocks into the line). */
  run(cyc: number): void {
    const t = this.t;
    const n = NUM * (cyc - t[1]!) + t[2]!;
    t[2] = n % DEN;
    t[0] = t[0]! - Math.trunc(n / DEN);
    this.smp.enter();
    t[1] = cyc;
  }

  read(port: number, cyc: number): number {
    this.run(cyc);
    return this.smp.portRead(port);
  }

  write(port: number, v: number, cyc: number): void {
    this.run(cyc);
    this.smp.portWrite(port, v);
  }

  /** The line ends at `cyc`; the CPU's clock then drops by `hMax`. */
  lineEnd(cyc: number, hMax: number): void {
    this.run(cyc);
    this.dsp.synchronize();
    this.t[1] = cyc - hMax;
  }

  save(): void {
    this.dsp.save(this.dspState);
  }

  load(): void {
    this.dsp.load(this.dspState);
  }

  /**
   * Take the state of a snes9x savestate's SND block (S9xAPUSaveState: SMP, DSP, reference
   * time, remainder, DSP clock, CPU ports).
   */
  loadSnes9x(b: Uint8Array): void {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    this.ram.set(b.subarray(0, 0x10000));
    let o = 0x10000;
    const int = (): number => {
      const v = dv.getInt32(o, true);
      o += 4;
      return v;
    };
    const smp = this.smp;
    const r = smp.r;
    const w = smp.w;
    smp.clock = int();
    r[ON] = int();
    r[OC] = int();
    w[PC] = int();
    r[S] = int();
    r[A] = int();
    r[X] = int();
    r[Y] = int();
    let p = 0;
    for (let k = 7; k >= 0; k--) p |= (int() ? 1 : 0) << k;
    smp.setP(p);
    r[IPL] = int() ? 1 : 0;
    r[DSP_ADDR] = int();
    r[F8] = int();
    r[F9] = int();
    for (let k = 0; k < 3; k++) for (let j = 0; j < 5; j++) r[T0 + 5 * k + j] = int();
    for (const k of [RD, WR, DP, SP, YA, BIT]) w[k] = int();
    o += this.dsp.loadSnes9x(b, o);
    this.t[1] = int();
    this.t[2] = int();
    this.dsp.clock = int();
    for (let k = 0; k < 4; k++) r[CPU_PORT + k] = b[o + k]!;
  }
}
