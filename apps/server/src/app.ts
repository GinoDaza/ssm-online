/**
 * One process, one port: the web client, the ROM (players never need their own copy) and the
 * WebSocket rooms. Friends on the LAN or a VPN open http://<host-ip>:PORT.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { attachRooms } from './rooms.ts';
import { loadRomFile } from './rom.ts';

export type Fallback = (req: IncomingMessage, res: ServerResponse) => void;

export function createApp(fallback: Fallback): Server {
  const rom = loadRomFile();
  let listRooms = (): unknown[] => [];
  const server = createServer((req, res) => {
    if (req.url === '/api/rom') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': rom.length });
      res.end(rom);
      return;
    }
    if (req.url === '/api/rooms') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(listRooms()));
      return;
    }
    fallback(req, res);
  });
  listRooms = attachRooms(server);
  return server;
}

export function listen(server: Server): void {
  const host = process.env['HOST'] ?? '0.0.0.0';
  const port = Number(process.env['PORT'] ?? 8790);
  server.listen(port, host, () => {
    console.log(`listening on ${host}:${port}`);
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) console.log(`  http://${a.address}:${port}`);
    }
  });
}
