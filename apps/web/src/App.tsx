import { useEffect, useRef, useState } from 'react';
import { HEIGHT, WIDTH } from '@ssm/core';
import { play, type Online, type Stats } from './play.ts';
import { Room, type Member } from './room.ts';

type Screen = { kind: 'menu' } | { kind: 'room'; room: Room } | { kind: 'game'; online: Online | null };

const params = new URLSearchParams(location.search);

/** Loads the ROM, then: a menu (local game or a room), the room's lobby, the game. */
export function App() {
  const [rom, setRom] = useState<Uint8Array | null>(null);
  const [error, setError] = useState('');
  const [screen, setScreen] = useState<Screen>({ kind: 'menu' });

  useEffect(() => {
    fetch('/api/rom')
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((buf) => setRom(new Uint8Array(buf)))
      .catch((e: unknown) => setError(`Could not load the game: ${String(e)}`));
  }, []);

  if (error) return <main className="app"><p>{error}</p></main>;
  if (!rom) return <main className="app"><p>Loading game data…</p></main>;

  const toMenu = () => {
    if (screen.kind === 'room') screen.room.close();
    if (screen.kind === 'game') screen.online?.room.close();
    setScreen({ kind: 'menu' });
  };

  return (
    <main className="app">
      {screen.kind === 'menu' && (
        <Menu
          onLocal={() => setScreen({ kind: 'game', online: null })}
          onJoin={(code, name) => setScreen({ kind: 'room', room: new Room(code, name) })}
        />
      )}
      {screen.kind === 'room' && <Lobby room={screen.room} onStart={(online) => setScreen({ kind: 'game', online })} onBack={toMenu} />}
      {screen.kind === 'game' && <GameView rom={rom} online={screen.online} onBack={toMenu} />}
    </main>
  );
}

function Menu({ onLocal, onJoin }: { onLocal: () => void; onJoin: (code: string, name: string) => void }) {
  const [name, setName] = useState(() => localStorage.getItem('name') ?? '');
  const [code, setCode] = useState(params.get('room') ?? '');
  const join = () => {
    localStorage.setItem('name', name);
    onJoin(code.trim() || 'SLAM', name.trim() || 'Player');
  };
  return (
    <section className="panel">
      <h1>Saturday Night Slam Masters</h1>
      <button onClick={onLocal}>Local game</button>
      <div className="row">
        <input placeholder="Your name" value={name} maxLength={16} onChange={(e) => setName(e.target.value)} />
        <input placeholder="Room (SLAM)" value={code} maxLength={16} onChange={(e) => setCode(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === 'Enter' && join()} />
        <button onClick={join}>Join room</button>
      </div>
    </section>
  );
}

function Lobby({ room, onStart, onBack }: { room: Room; onStart: (o: Online) => void; onBack: () => void }) {
  const [, redraw] = useState(0);
  const [closed, setClosed] = useState(false);
  const [delay, setDelay] = useState(Number(params.get('delay') ?? 2));

  useEffect(() => {
    room.onChange = () => redraw((n) => n + 1);
    room.onClose = () => setClosed(true);
    room.onStart = (msg) => {
      const slot = msg.players.indexOf(room.me);
      if (slot < 0) return; // the room was full: stay in the lobby
      onStart({ room, players: msg.players.length, slot, delay: msg.delay });
    };
    const t = setInterval(() => redraw((n) => n + 1), 1000); // ping
    return () => clearInterval(t);
  }, [room, onStart]);

  if (closed) return <section className="panel"><p>Lost the connection to the server.</p><button onClick={onBack}>Back</button></section>;
  return (
    <section className="panel">
      <h1>Room {room.code || '…'}</h1>
      <ol className="members">
        {room.members.map((m: Member, k) => (
          <li key={m.peer}>
            {m.name} {m.peer === room.me && '(you)'} {k === 0 && '· host'} {k >= 4 && '· watching (room full)'}
          </li>
        ))}
      </ol>
      <p className="help">Ping to the server: {room.ping} ms. Friends join with the same room name.</p>
      {room.isHost ? (
        <div className="row">
          <label>
            Input delay{' '}
            <select value={delay} onChange={(e) => setDelay(Number(e.target.value))}>
              {[0, 1, 2, 3, 4, 5].map((d) => <option key={d} value={d}>{d} {d === 2 ? '(LAN)' : d === 3 ? '(internet)' : ''}</option>)}
            </select>
          </label>
          <button disabled={room.members.length < 2} onClick={() => room.start(delay)}>Start</button>
        </div>
      ) : (
        <p>Waiting for the host to start…</p>
      )}
      <button onClick={onBack}>Leave</button>
    </section>
  );
}

function GameView({ rom, online, onBack }: { rom: Uint8Array; online: Online | null; onBack: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!canvas.current) return;
    const stop = play(canvas.current, rom, online, setStats);
    if (online) {
      online.room.onLeave = (m) => setNotice(`${m.name} left the match.`);
      online.room.onClose = () => setNotice('Lost the connection to the server.');
    }
    return stop;
  }, [rom, online]);

  return (
    <>
      <canvas ref={canvas} className="screen" width={WIDTH} height={HEIGHT} />
      {notice && <p className="notice">{notice}</p>}
      {online && stats && (
        <p className="stats">
          Player {online.slot + 1} of {online.players} · delay {online.delay} · ping {online.room.ping} ms · frame {stats.frame} ·
          rollbacks {stats.rollbacks} ({stats.resimulated} frames) · waits {stats.stalls} · time sync {stats.skipped}
          {stats.desync >= 0 && <strong> · DESYNC at frame {stats.desync}</strong>}
        </p>
      )}
      <p className="help">
        Arrows move · Z = B · X = A · A = Y · S = X · Q / W = L / R · Enter = Start · Right Shift = Select · gamepads work
        too{online ? ' (the first one plays your slot)' : ' (pads 1-4)'}. Sound starts with the first key press or click.
      </p>
      <p className="help"><button onClick={onBack}>{online ? 'Leave the match' : 'Menu'}</button></p>
    </>
  );
}
