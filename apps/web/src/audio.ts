/**
 * Plays the game's sound through Web Audio. Each frame's samples (32040 Hz stereo s16) go to an
 * AudioWorklet that keeps a short queue. The game is paced by the display, not by the sound
 * card, so the worklet reads slightly faster or slower to keep the queue near its target and
 * interpolates between samples. That pitch change is never more than 0.5%.
 *
 * AudioWorklet exists only in secure contexts (https or localhost); friends who open
 * http://<host-ip>:PORT get the same processor run on the main thread by a ScriptProcessorNode.
 */
import { SAMPLE_RATE } from '@ssm/core';

const WORKLET = `
class GameSound extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { inRate } = options.processorOptions;
    this.ratio = inRate / sampleRate;   // input samples per output sample
    this.size = 1 << 15;                // queue of sample pairs
    this.l = new Float32Array(this.size);
    this.r = new Float32Array(this.size);
    this.head = 0;                      // next write
    this.pos = 0;                       // read position (fractional, absolute)
    this.written = 0;                   // absolute count written
    this.target = inRate * 0.06;        // aim for ~60 ms queued
    this.started = false;
    this.port.onmessage = (e) => {
      const s = e.data;
      for (let i = 0; i + 1 < s.length; i += 2) {
        this.l[this.head] = s[i] / 32768;
        this.r[this.head] = s[i + 1] / 32768;
        this.head = (this.head + 1) & (this.size - 1);
        this.written++;
      }
      // fell too far behind (tab in background): drop to the target
      if (this.written - this.pos > this.target * 4) this.pos = this.written - this.target;
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] ?? out[0];
    const queued = this.written - this.pos;
    if (!this.started && queued >= this.target) this.started = true;
    const adjust = Math.max(-0.005, Math.min(0.005, (queued - this.target) / this.target * 0.01));
    const step = this.ratio * (1 + adjust);
    const mask = this.size - 1;
    for (let k = 0; k < L.length; k++) {
      if (!this.started || this.written - this.pos < 2) {
        this.started = false;
        L[k] = 0;
        R[k] = 0;
        continue;
      }
      const i = Math.floor(this.pos);
      const f = this.pos - i;
      const a = i & mask, b = (i + 1) & mask;
      L[k] = this.l[a] + (this.l[b] - this.l[a]) * f;
      R[k] = this.r[a] + (this.r[b] - this.r[a]) * f;
      this.pos += step;
    }
    return true;
  }
}
registerProcessor('game-sound', GameSound);
`;

/** The part of a worklet processor the speaker talks to. */
interface Processor {
  port: { onmessage: ((e: { data: Int16Array }) => void) | null };
  process(inputs: unknown, outputs: Float32Array[][]): boolean;
}

/** Run the worklet's processor on the main thread, behind a ScriptProcessorNode. */
function mainThreadSound(ctx: AudioContext): { node: AudioNode; post: (s: Int16Array) => void } {
  class Base {
    port: Processor['port'] = { onmessage: null };
  }
  let Ctor: (new (options: unknown) => Processor) | null = null;
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', WORKLET)(
    Base,
    (_name: string, c: new (options: unknown) => Processor) => (Ctor = c),
    ctx.sampleRate,
  );
  const proc = new Ctor!({ processorOptions: { inRate: SAMPLE_RATE } });
  const node = ctx.createScriptProcessor(1024, 0, 2);
  node.onaudioprocess = (e) => {
    const out = e.outputBuffer;
    proc.process([], [[out.getChannelData(0), out.getChannelData(1)]]);
  };
  return { node, post: (s) => proc.port.onmessage?.({ data: s }) };
}

export class Speaker {
  private ctx: AudioContext | null = null;
  private post: ((samples: Int16Array) => void) | null = null;
  private readonly resume = () => void this.ctx?.resume();

  /** Set up the audio graph; it starts playing after the first key press or click. */
  async start(): Promise<void> {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    // browsers start audio only after a user gesture
    window.addEventListener('keydown', this.resume);
    window.addEventListener('pointerdown', this.resume);
    if (ctx.audioWorklet) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      if (this.ctx !== ctx) return; // stopped while the worklet loaded
      const node = new AudioWorkletNode(ctx, 'game-sound', {
        numberOfInputs: 0,
        outputChannelCount: [2],
        processorOptions: { inRate: SAMPLE_RATE },
      });
      node.connect(ctx.destination);
      this.post = (s) => node.port.postMessage(s);
    } else {
      const { node, post } = mainThreadSound(ctx);
      node.connect(ctx.destination);
      this.post = post;
    }
    void ctx.resume();
  }

  /** Queue one frame's samples (interleaved stereo s16). */
  push(samples: Int16Array): void {
    if (this.post && samples.length) this.post(samples.slice());
  }

  stop(): void {
    window.removeEventListener('keydown', this.resume);
    window.removeEventListener('pointerdown', this.resume);
    void this.ctx?.close();
    this.ctx = null;
    this.post = null;
  }
}
