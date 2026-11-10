import { useEffect, useRef, useState } from 'react';
import { HEIGHT } from '@ssm/core';
import { PLAYABLE_RULES, rulesById, type Ruleset } from '@ssm/rules';
import { Fit, useGameScale } from './Fit.tsx';
import { KEY_HELP } from './input.ts';
import { play, type Online } from './play.ts';
import { Room } from './room.ts';

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

interface RoomInfo {
  code: string;
  players: string[];
  playing: boolean;
}

/** The server's open rooms, refreshed every 2 s. */
function useRooms(): RoomInfo[] {
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  useEffect(() => {
    let alive = true;
    const get = () =>
      fetch('/api/rooms')
        .then((r) => r.json())
        .then((list: RoomInfo[]) => alive && setRooms(list))
        .catch(() => {});
    get();
    const t = setInterval(get, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return rooms;
}

/** A free room name: ROOM1, ROOM2… */
function newRoomCode(taken: RoomInfo[]): string {
  for (let n = 1; ; n++) if (!taken.some((r) => r.code === `ROOM${n}`)) return `ROOM${n}`;
}

function Menu({ rules, setRules, onLocal, onJoin }: RulesProps & { onLocal: () => void; onJoin: (code: string, name: string) => void }) {
  const [name, setName] = useState(() => load('name') ?? '');
  const [code, setCode] = useState(params.get('room') ?? '');
  const rooms = useRooms();
  const join = (room: string) => {
    if (!room.trim()) return;
    save('name', name);
    onJoin(room.trim(), name.trim() || 'Player');
  };
  return (
    <section className="panel">
      <h1>Saturday Night Slam Masters</h1>
      <div className="row">
        <button onClick={onLocal}>Local game</button>
        <RulesPicker rules={rules} setRules={setRules} />
      </div>
      <input placeholder="Your name" value={name} maxLength={16} onChange={(e) => setName(e.target.value)} />
      <ul className="rooms">
        {rooms.length === 0 && <li className="help">No rooms yet</li>}
        {rooms.map((r) => (
          <li key={r.code}>
            <b>{r.code}</b>
            <span className="help">
              {r.players.join(', ')} · {r.playing ? 'playing' : `${r.players.length}/4`}
            </span>
            <button disabled={r.playing || r.players.length >= 4} onClick={() => join(r.code)}>
              Join
            </button>
          </li>
        ))}
      </ul>
      <div className="row">
        <button onClick={() => join(newRoomCode(rooms))}>Create room</button>
        <input placeholder="Room name" value={code} maxLength={16} onChange={(e) => setCode(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === 'Enter' && join(code)} />
        <button disabled={!code.trim()} onClick={() => join(code)}>Join room</button>
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
  const [copied, setCopied] = useState(false);
  /** host: the slot picked to swap with one of the other team */
  const [picked, setPicked] = useState<number | null>(null);
  const copyInvite = () => {
    const link = `${location.origin}/?room=${encodeURIComponent(room.code)}`;
    navigator.clipboard?.writeText(link).then(
      () => setCopied(true),
      () => prompt('Invite link', link),
    ) ?? prompt('Invite link', link);
  };

  useEffect(() => {
    room.onChange = () => {
      setPicked(null); // the slots may have moved
      redraw((n) => n + 1);
    };
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
      <div className="teams">
        {[0, 1].map((team) => (
          <div key={team} className={`team-box team-${team}`}>
            <h2>Team {team + 1}</h2>
            {[team, team + 2].map((k) => {
              const m = room.ordered[k];
              if (!m) return <p key={k} className="help">P{k + 1} · CPU</p>;
              const others = [1 - team, 3 - team].filter((j) => room.ordered[j]);
              return (
                <p key={k} className={picked === k ? 'picked' : ''}>
                  <span>
                    P{k + 1} {m.name} {m.peer === room.me && '(you)'} {m.peer === room.members[0]?.peer && '· host'}
                  </span>
                  {room.isHost && picked === null && others.length > 0 && (
                    <button onClick={() => (others.length === 1 ? room.swap(k, others[0]!) : setPicked(k))}>
                      {team ? '← Team 1' : 'Team 2 →'}
                    </button>
                  )}
                  {room.isHost && picked !== null && picked % 2 !== team && (
                    <button onClick={() => (room.swap(picked, k), setPicked(null))}>Swap</button>
                  )}
                  {room.isHost && picked === k && <button onClick={() => setPicked(null)}>Cancel</button>}
                </p>
              );
            })}
          </div>
        ))}
      </div>
      {room.isHost && room.members.length > 1 && (
        <div className="row">
          <button onClick={() => (setPicked(null), room.shuffle())}>Random teams</button>
        </div>
      )}
      {room.ordered.length > 4 && <p className="help">Watching (room full): {room.ordered.slice(4).map((m) => m.name).join(', ')}</p>}
      <p className="help">Friends join with the same room name · ping {room.ping} ms</p>
      <p className="help">Up to 4 players: in Team Battle Royal players 3 and 4 join by pressing Start. Teams count in Team Battle Royal; in a single match P1 fights P2</p>
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
      <div className="row">
        <button onClick={onBack}>Leave</button>
        <button onClick={copyInvite}>{copied ? 'Copied!' : 'Copy invite link'}</button>
      </div>
      <Controls />
    </section>
  );
}

/** The game alone on a black screen, filling it. Esc leaves. */
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
