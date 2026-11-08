/** Production: serve the built client (apps/web/dist). */
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { createApp, listen } from './app.ts';
import { REPO_ROOT } from './rom.ts';

const DIST = resolve(REPO_ROOT, 'apps/web/dist');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

listen(
  createApp((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname));
    let file = join(DIST, path);
    if (!file.startsWith(DIST) || path === '/' || !existsSync(file)) file = join(DIST, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  }),
);
