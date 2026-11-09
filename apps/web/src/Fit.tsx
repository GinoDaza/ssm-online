/**
 * Screen geometry. Menus are designed on a fixed 1600x900 screen that Fit scales to the
 * window (CSS zoom), so they fit without scrolling on 16:9 and 16:10 alike; text is 24 px,
 * never under 16 px, at that size. The game picture fills the window as far as its aspect
 * allows (any scale, not only whole ones: a window a little short of 4x would otherwise drop
 * to 3x with wide black borders); pixels stay hard-edged (image-rendering: pixelated).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { HEIGHT, WIDTH } from '@ssm/core';

export const SCREEN_W = 1600;
export const SCREEN_H = 900;

function useWindowSize(): [number, number] {
  const [size, setSize] = useState<[number, number]>([innerWidth, innerHeight]);
  useEffect(() => {
    const onResize = () => setSize([innerWidth, innerHeight]);
    addEventListener('resize', onResize);
    return () => removeEventListener('resize', onResize);
  }, []);
  return size;
}

export function Fit({ children }: { children: ReactNode }) {
  const [w, h] = useWindowSize();
  const zoom = Math.min(w / SCREEN_W, h / SCREEN_H);
  return (
    <div className="fit">
      <div className="screen-1600" style={{ width: SCREEN_W, height: SCREEN_H, zoom }}>
        {children}
      </div>
    </div>
  );
}

/** Scale of a game picture `width` pixels wide that fills the window (aspect kept). */
export function useGameScale(width = WIDTH): number {
  const [w, h] = useWindowSize();
  return Math.min(w / width, h / HEIGHT);
}
