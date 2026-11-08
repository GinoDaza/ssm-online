import { useEffect, useState } from 'react';
import { Game, RomImage } from '@ssm/core';

/** Loads the ROM from the server and runs the game at 60 frames a second (no picture yet). */
export function App() {
  const [status, setStatus] = useState('Loading game data…');

  useEffect(() => {
    let raf = 0;
    let stopped = false;
    fetch('/api/rom')
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((buf) => {
        if (stopped) return;
        const game = new Game(new RomImage(new Uint8Array(buf)));
        game.powerOn();
        let last = performance.now();
        let acc = 0;
        let cost = 0;
        const loop = (now: number) => {
          acc += Math.min(now - last, 100);
          last = now;
          while (acc >= 1000 / 60) {
            acc -= 1000 / 60;
            const t0 = performance.now();
            game.step([0, 0, 0, 0]);
            cost = cost * 0.95 + (performance.now() - t0) * 0.05;
          }
          setStatus(`Frame ${game.frame}, ${cost.toFixed(2)} ms per frame. Rendering is next.`);
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
      })
      .catch((e: unknown) => setStatus(`Could not load the game: ${String(e)}`));
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <main className="app">
      <h1>SSM Online</h1>
      <p>{status}</p>
    </main>
  );
}
