/**
 * Runs the game in the page at 60 frames a second: picture on a canvas, sound through Web
 * Audio. Local play steps the game with the local pads; online play ticks a Netplay session,
 * which may re-simulate frames (the renderer and the sound are detached meanwhile).
 */
import { Game, HEIGHT, Netplay, Renderer, RomImage, Sound } from '@ssm/core';
import { installRules, presetTeamSize, type Ruleset } from '@ssm/rules';
import { Speaker } from './audio.ts';
import { Controls } from './input.ts';
import type { Room } from './room.ts';

const FRAME_MS = 1000 / 60;

export interface Online {
  room: Room;
  /** the session slots in play (the seated players' pads), and the local one */
  slots: number[];
  slot: number;
  /** wrestlers a team, the lobby's (the Game Mode Select comes up on it) */
  size: number;
  delay: number;
}

export interface Stats {
  frame: number;
  rollbacks: number;
  resimulated: number;
  stalls: number;
  skipped: number;
  lead: number;
  desync: number;
}

/** Start the game; returns the function that stops it. */
export function play(canvas: HTMLCanvasElement, rom: Uint8Array, rules: Ruleset, online: Online | null, onStats: (s: Stats) => void): () => void {
  const controls = new Controls();
  controls.attach();
  const speaker = new Speaker();
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(rules.screenWidth, HEIGHT);
  const game = new Game(new RomImage(rom));
  installRules(game, rules);
  const renderer = new Renderer(game.m, rules.screenWidth);
  renderer.attach();
  const sound = new Sound(game.m);
  sound.attach();
  speaker.start().catch((e: unknown) => console.warn('no sound:', e));
  game.powerOn();
  // a multitap in port 2, as on the console: pads 3 and 4 play when a third or fourth player
  // is there (online slots 3-4, more gamepads); pads nobody holds read 0
  game.m.multitap = true;
  if (online && rules.modeMenu) presetTeamSize(game.m, online.size);

  let net: Netplay | null = null;
  if (online) {
    net = new Netplay(game, { slots: online.slots, slot: online.slot, delay: online.delay });
    net.send = (data) => online.room.sendBinary(data);
    online.room.onBinary = (data) => net!.receive(data);
    net.session.onResim = (active) => {
      if (active) {
        renderer.detach();
        sound.detach();
      } else {
        renderer.attach();
        sound.attach();
      }
    };
  }

  let raf = 0;
  let last = performance.now();
  let acc = 0;
  let statsAt = 0;
  const loop = (now: number) => {
    acc += Math.min(now - last, 100);
    last = now;
    let ran = false;
    while (acc >= FRAME_MS) {
      acc -= FRAME_MS;
      const pads = controls.read();
      if (net) {
        // keyboard and the first gamepad drive the local slot
        if (net.tick(pads[0]!)) ran = true;
      } else {
        game.step(pads);
        ran = true;
      }
      speaker.push(sound.take());
    }
    if (ran) {
      renderer.toRgba(image.data);
      ctx.putImageData(image, 0, 0);
    }
    if (net && now - statsAt > 250) {
      statsAt = now;
      const s = net.session;
      onStats({ frame: s.frame, rollbacks: s.rollbacks, resimulated: s.resimulated, stalls: net.stalls, skipped: net.skipped, lead: net.lead, desync: net.desync });
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return () => {
    cancelAnimationFrame(raf);
    controls.detach();
    speaker.stop();
    if (online) online.room.onBinary = () => {};
  };
}
