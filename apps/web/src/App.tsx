import { useEffect, useRef, useState } from 'react';
import { HEIGHT, WIDTH } from '@ssm/core';
import { Fit, useGameScale } from './Fit.tsx';
import { KEY_HELP } from './input.ts';
import { play, type Online } from './play.ts';
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

  if (error) return <Fit><section className="panel"><p>{error}</p></section></Fit>;
  if (!rom) return <Fit><section className="panel"><p>Loading game data…</p></section></Fit>;

  const toMenu = () => {
    if (screen.kind === 'room') screen.room.close();
    if (screen.kind === 'game') screen.online?.room.close();
    setScreen({ kind: 'menu' });
  };

  return (
    <>
      {screen.kind === 'menu' && (
        <Fit>
          <Menu
            onLocal={() => setScreen({ kind: 'game', online: null })}
            onJoin={(code, name) => setScreen({ kind: 'room', room: new Room(code, name) })}
          />
        </Fit>
      )}
      {screen.kind === 'room' && (
        <Fit>
          <Lobby room={screen.room} onStart={(online) => setScreen({ kind: 'game', online })} onBack={toMenu} />
        </Fit>
      )}
      {screen.kind === 'game' && <GameView rom={rom} online={screen.online} onBack={toMenu} />}
    </>
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
      <Controls />
    </section>
  );
}

function Controls() {
  return (
    <dl className="keys">
      {KEY_HELP.map(([k, what]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{what}</dd>
        </div>
      ))}
    </dl>
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
      <p className="help">Friends join with the same room name · ping {room.ping} ms</p>
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
      <Controls />
    </section>
  );
}

/** The game alone on a black screen, at an integer scale. Esc leaves. */
function GameView({ rom, online, onBack }: { rom: Uint8Array; online: Online | null; onBack: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scale = useGameScale();
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!canvas.current) return;
    const stop = play(canvas.current, rom, online, (s) => s.desync >= 0 && setNotice(`Desync at frame ${s.desync}.`));
    if (online) {
      online.room.onLeave = (m) => setNotice(`${m.name} left the match.`);
      online.room.onClose = () => setNotice('Lost the connection to the server.');
    }
    return stop;
  }, [rom, online]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.code === 'Escape' && onBack();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onBack]);

  return (
    <div className="game">
      <canvas ref={canvas} width={WIDTH} height={HEIGHT} style={{ width: WIDTH * scale, height: HEIGHT * scale }} />
      {notice && <p className="notice">{notice} Esc to leave.</p>}
    </div>
  );
}
