import { useEffect, useRef, useState } from 'react';
import { HEIGHT } from '@ssm/core';
import { PLAYABLE_RULES, rulesById, type Ruleset } from '@ssm/rules';
import { Fit, useGameScale } from './Fit.tsx';
import { KEY_HELP } from './input.ts';
import { play, type Online } from './play.ts';
import { MAX_PLAYERS, Room, TEAM_SEATS } from './room.ts';

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
              {r.players.join(', ')} · {r.playing ? 'playing' : `${r.players.length}/${MAX_PLAYERS}`}
            </span>
            <button disabled={r.playing || r.players.length >= MAX_PLAYERS} onClick={() => join(r.code)}>
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
  /** host: the seat picked to move to another */
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
      setPicked(null); // the seats may have moved
      redraw((n) => n + 1);
    };
    room.onClose = () => setClosed(true);
    room.onStart = (msg) => {
      const mine = msg.players.find((p) => p.peer === room.me);
      if (!mine) return; // no seat: stay in the lobby
      onStart({ room, slots: msg.players.map((p) => p.slot), slot: mine.slot, size: msg.size, delay: msg.delay }, rulesById(msg.rules));
    };
    const t = setInterval(() => redraw((n) => n + 1), 1000); // ping
    return () => clearInterval(t);
  }, [room, onStart]);

  // 3 VS 3 and 4 VS 4 are the Game Mode Select's (Ruleset.modeMenu)
  useEffect(() => {
    if (room.isHost && !rules.modeMenu && room.size > 2) room.setSize(2);
  }, [room, rules]);

  if (closed) return <section className="panel"><p>Lost the connection to the server.</p><button onClick={onBack}>Back</button></section>;
  const sizes = rules.modeMenu ? [1, 2, 3, 4] : [1, 2];
  return (
    <section className="panel">
      <h1>Room {room.code || '…'}</h1>
      <div className="row">
        {room.isHost ? (
          <label className="row">
            Match
            <select value={room.size} onChange={(e) => room.setSize(Number(e.target.value))}>
              {sizes.map((n) => <option key={n} value={n}>{n} VS {n}</option>)}
            </select>
          </label>
        ) : (
          <p>{room.size} VS {room.size}</p>
        )}
      </div>
      <div className="teams">
        {[0, 1].map((team) => (
          <div key={team} className={`team-box team-${team}`}>
            <h2>Team {team + 1}</h2>
            {room.open.filter((s) => Math.floor(s / TEAM_SEATS) === team).map((s) => {
              const m = room.seated(s);
              return (
                <p key={s} className={picked === s ? 'picked' : m ? '' : 'help'}>
                  <span>
                    P{room.number(s)} {m ? m.name : 'CPU'} {m?.peer === room.me && '(you)'} {m && m.peer === room.members[0]?.peer && '· host'}
                  </span>
                  {room.isHost && picked === null && m && <button onClick={() => setPicked(s)}>Move</button>}
                  {room.isHost && picked !== null && picked !== s && <button onClick={() => (room.swap(picked, s), setPicked(null))}>{m ? 'Swap' : 'Here'}</button>}
                  {room.isHost && picked === s && <button onClick={() => setPicked(null)}>Cancel</button>}
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
      {room.watching.length > 0 && <p className="help">Watching: {room.watching.map((m) => m.name).join(', ')}</p>}
      <p className="help">Friends join with the same room name · ping {room.ping} ms</p>
      <p className="help">
        Up to {MAX_PLAYERS} players; empty seats are the CPU. P1 drives the menus. In the game everyone else joins by pressing Start (on the Game Mode Select or on ENTER THE MATCH); in 3 VS 3 and 4 VS 4 the third and fourth of a team then pick their wrestler beside the player select.
      </p>
      {room.isHost ? (
        <div className="row">
          <RulesPicker rules={rules} setRules={setRules} />
          <label className="row">
            Input delay
            <select value={delay} onChange={(e) => setDelay(Number(e.target.value))}>
              {[0, 1, 2, 3, 4, 5].map((d) => <option key={d} value={d}>{d} {d === 2 ? '(LAN)' : d === 3 ? '(internet)' : ''}</option>)}
            </select>
          </label>
          <button disabled={!room.ready} onClick={() => room.start(delay, rules.id)}>Start</button>
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
