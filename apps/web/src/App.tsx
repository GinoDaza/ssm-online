import { useEffect, useRef, useState } from 'react';
import { HEIGHT } from '@ssm/core';
import { PLAYABLE_RULES, rulesById, type Ruleset } from '@ssm/rules';
import { Fit, useGameScale } from './Fit.tsx';
import { KEY_HELP } from './input.ts';
import { play, type Online } from './play.ts';
import { Room, type Member } from './room.ts';

type Screen = { kind: 'menu' } | { kind: 'room'; room: Room } | { kind: 'game'; online: Online | null; rules: Ruleset };

const params = new URLSearchParams(location.search);

/** Loads the ROM, then: a menu (local game or a room), the room's lobby, the game. */
export function App() {
  const [rom, setRom] = useState<Uint8Array | null>(null);
  const [error, setError] = useState('');
  const [screen, setScreen] = useState<Screen>({ kind: 'menu' });
  const [rules, setRulesId] = useState(() => rulesById(load('rules') ?? ''));
  const setRules = (id: string) => {
    save('rules', id);
    setRulesId(rulesById(id));
  };

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
            rules={rules}
            setRules={setRules}
            onLocal={() => setScreen({ kind: 'game', online: null, rules })}
            onJoin={(code, name) => setScreen({ kind: 'room', room: new Room(code, name) })}
          />
        </Fit>
      )}
      {screen.kind === 'room' && (
        <Fit>
          <Lobby room={screen.room} rules={rules} setRules={setRules} onStart={(online, r) => setScreen({ kind: 'game', online, rules: r })} onBack={toMenu} />
        </Fit>
      )}
      {screen.kind === 'game' && <GameView rom={rom} online={screen.online} rules={screen.rules} onBack={toMenu} />}
    </>
  );
}

/** Per-browser conveniences (name, last rules); storage may be unavailable. */
function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not remembered
  }
}

function RulesPicker({ rules, setRules }: { rules: Ruleset; setRules: (id: string) => void }) {
  return (
    <label className="row">
      Rules
      <select value={rules.id} onChange={(e) => setRules(e.target.value)}>
        {PLAYABLE_RULES.map((r) => (
          <option key={r.id} value={r.id}>
            {r.label}
          </option>
        ))}
      </select>
    </label>
  );
}

interface RulesProps {
  rules: Ruleset;
  setRules: (id: string) => void;
}

function Menu({ rules, setRules, onLocal, onJoin }: RulesProps & { onLocal: () => void; onJoin: (code: string, name: string) => void }) {
  const [name, setName] = useState(() => load('name') ?? '');
  const [code, setCode] = useState(params.get('room') ?? '');
  const join = () => {
    save('name', name);
    onJoin(code.trim() || 'SLAM', name.trim() || 'Player');
  };
  return (
    <section className="panel">
      <h1>Saturday Night Slam Masters</h1>
      <div className="row">
        <button onClick={onLocal}>Local game</button>
        <RulesPicker rules={rules} setRules={setRules} />
      </div>
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

function Lobby({ room, rules, setRules, onStart, onBack }: RulesProps & { room: Room; onStart: (o: Online, rules: Ruleset) => void; onBack: () => void }) {
  const [, redraw] = useState(0);
  const [closed, setClosed] = useState(false);
  const [delay, setDelay] = useState(Number(params.get('delay') ?? 2));

  useEffect(() => {
    room.onChange = () => redraw((n) => n + 1);
    room.onClose = () => setClosed(true);
    room.onStart = (msg) => {
      const slot = msg.players.indexOf(room.me);
      if (slot < 0) return; // the room was full: stay in the lobby
      onStart({ room, players: msg.players.length, slot, delay: msg.delay }, rulesById(msg.rules));
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
          <RulesPicker rules={rules} setRules={setRules} />
          <label className="row">
            Input delay
            <select value={delay} onChange={(e) => setDelay(Number(e.target.value))}>
              {[0, 1, 2, 3, 4, 5].map((d) => <option key={d} value={d}>{d} {d === 2 ? '(LAN)' : d === 3 ? '(internet)' : ''}</option>)}
            </select>
          </label>
          <button disabled={room.members.length < 2} onClick={() => room.start(delay, rules.id)}>Start</button>
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
function GameView({ rom, online, rules, onBack }: { rom: Uint8Array; online: Online | null; rules: Ruleset; onBack: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scale = useGameScale(rules.screenWidth);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!canvas.current) return;
    const stop = play(canvas.current, rom, rules, online, (s) => s.desync >= 0 && setNotice(`Desync at frame ${s.desync}.`));
    if (online) {
      online.room.onLeave = (m) => setNotice(`${m.name} left the match.`);
      online.room.onClose = () => setNotice('Lost the connection to the server.');
    }
    return stop;
  }, [rom, online, rules]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.code === 'Escape' && onBack();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onBack]);

  return (
    <div className="game">
      <canvas ref={canvas} width={rules.screenWidth} height={HEIGHT} style={{ width: rules.screenWidth * scale, height: HEIGHT * scale }} />
      {notice && <p className="notice">{notice} Esc to leave.</p>}
    </div>
  );
}
