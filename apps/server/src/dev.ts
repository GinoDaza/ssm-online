/** Development: the same server with Vite (hot reload) on the same port. */
import { resolve } from 'node:path';
import { createServer as createVite } from 'vite';
import { createApp, listen } from './app.ts';
import { REPO_ROOT } from './rom.ts';

let handle: ((req: never, res: never, next: () => void) => void) | null = null;
const server = createApp((req, res) => {
  if (!handle) return void res.writeHead(503).end('starting');
  handle(req as never, res as never, () => res.writeHead(404).end());
});
const vite = await createVite({
  root: resolve(REPO_ROOT, 'apps/web'),
  server: { middlewareMode: true, hmr: { server } },
  appType: 'spa',
});
handle = vite.middlewares as never;
listen(server);
