/**
 * The sound the DSP plays, for the host: stereo s16 samples at SAMPLE_RATE, interleaved
 * (left, right). Like the renderer it is outside the rollback state: detach it while a
 * rollback re-simulates frames that were already heard.
 */
import type { Machine } from '../cpu/machine.ts';

/** DSP output rate (the SPC clock / 32) */
export const SAMPLE_RATE = 32040;

export class Sound {
  /** room for a few frames (a frame is about 533 sample pairs) */
  readonly samples = new Int16Array(2 * 4096);
  private readonly m: Machine;

  constructor(m: Machine) {
    this.m = m;
  }

  attach(): void {
    this.m.apu.dsp.out = this.samples;
  }

  detach(): void {
    this.m.apu.dsp.out = null;
  }

  /** The samples played since the last take() (a view, valid until the next frame runs). */
  take(): Int16Array {
    const dsp = this.m.apu.dsp;
    const n = dsp.outCount;
    dsp.outCount = 0;
    return this.samples.subarray(0, n);
  }
}
