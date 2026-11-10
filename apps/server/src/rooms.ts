/**
 * Rooms over WebSocket (/ws). The server relays; it never decides game state. JSON
 * messages for control, binary messages (game inputs) relayed as they are.
 *   client -> server  {t: 'join', room, name}   {t: 'ping', id}   anything else: relayed
 *   server -> client  {t: 'joined', room, peer, peers}  {t: 'peer-join'|'peer-leave', peer}
 *                     {t: 'pong', id}
 * The room list (code, names, whether a match started) is public: GET /api/rooms.
 */
import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

interface Peer {
  id: number;
  name: string;
  ws: WebSocket;
}

export interface RoomInfo {
  code: string;
  players: string[];
  playing: boolean;
}

/** Attaches the relay; returns the current room list. */
export function attachRooms(server: Server): () => RoomInfo[] {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const rooms = new Map<string, Map<number, Peer>>();
  /** rooms whose host sent `start`; cleared when the room empties */
  const playing = new Set<string>();
  let nextId = 1;

  wss.on('connection', (ws) => {
    let room: string | null = null;
    const id = nextId++;
    let name = `player${id}`;

    ws.on('message', (raw, binary) => {
      if (binary) {
        if (room) relay(room, id, raw as Buffer, true);
        return;
      }
      let msg: { t?: string; room?: string; name?: string; id?: number };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.t === 'ping') {
        ws.send(JSON.stringify({ t: 'pong', id: msg.id }));
      } else if (msg.t === 'join' && typeof msg.room === 'string' && room === null) {
        room = msg.room.slice(0, 16).toUpperCase();
        name = (msg.name ?? name).slice(0, 16);
        const peers = rooms.get(room) ?? new Map<number, Peer>();
        rooms.set(room, peers);
        const others = [...peers.values()].map((p) => ({ peer: p.id, name: p.name }));
        peers.set(id, { id, name, ws });
        ws.send(JSON.stringify({ t: 'joined', room, peer: id, peers: others }));
        broadcast(room, id, JSON.stringify({ t: 'peer-join', peer: id, name }));
      } else if (room) {
        if (msg.t === 'start') playing.add(room);
        relay(room, id, JSON.stringify({ ...msg, from: id }), false);
      }
    });

    ws.on('close', () => {
      if (!room) return;
      const peers = rooms.get(room);
      peers?.delete(id);
      if (peers && peers.size === 0) {
        rooms.delete(room);
        playing.delete(room);
      }
      else broadcast(room, id, JSON.stringify({ t: 'peer-leave', peer: id }));
    });
  });

  function broadcast(room: string, from: number, data: string): void {
    for (const p of rooms.get(room)?.values() ?? []) if (p.id !== from) p.ws.send(data);
  }

  function relay(room: string, from: number, data: Buffer | string, binary: boolean): void {
    for (const p of rooms.get(room)?.values() ?? []) if (p.id !== from) p.ws.send(data, { binary });
  }

  return () => [...rooms].map(([code, peers]) => ({ code, players: [...peers.values()].map((p) => p.name), playing: playing.has(code) }));
}
