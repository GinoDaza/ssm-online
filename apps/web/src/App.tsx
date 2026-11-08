import { useEffect, useRef, useState } from 'react';
import { Game, HEIGHT, Renderer, RomImage, WIDTH } from '@ssm/core';
import { Controls } from './input.ts';

const FRAME_MS = 1000 / 60;

/** Loads the ROM from the server and runs the game at 60 frames a second, drawn on a canvas. */
export function App() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState('Loading game data…');

  useEffect(() => {
    let raf = 0;
    let stopped = false;
    const controls = new Controls();
    controls.attach();
    fetch('/api/rom')
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((buf) => {
        if (stopped || !canvas.current) return;
        const ctx = canvas.current.getContext('2d')!;
        const image = ctx.createImageData(WIDTH, HEIGHT);
        const game = new Game(new RomImage(new Uint8Array(buf)));
        const renderer = new Renderer(game.m);
        renderer.attach();
        game.powerOn();
        setStatus('');
        let last = performance.now();
        let acc = 0;
        const loop = (now: number) => {
          acc += Math.min(now - last, 100);
          last = now;
          let ran = false;
          while (acc >= FRAME_MS) {
            acc -= FRAME_MS;
            game.step(controls.read());
            ran = true;
          }
          if (ran) {
            renderer.toRgba(image.data);
            ctx.putImageData(image, 0, 0);
          }
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
      })
      .catch((e: unknown) => setStatus(`Could not load the game: ${String(e)}`));
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      controls.detach();
    };
  }, []);

  return (
    <main className="app">
      <canvas ref={canvas} className="screen" width={WIDTH} height={HEIGHT} />
      {status && <p>{status}</p>}
      <p className="help">
        Arrows move · Z = B · X = A · A = Y · S = X · Q / W = L / R · Enter = Start · Right Shift = Select · gamepads
        work too (pads 1-4). No sound yet.
      </p>
    </main>
  );
}
