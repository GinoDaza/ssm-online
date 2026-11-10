/**
 * A room on the server's WebSocket relay (/ws). The server only relays: the peer with the
 * lowest id is the host, and its `start` message fixes the seats, the team size and the input
 * delay for everyone. Before the start the host seats the players (`seats` messages): two
 * teams of `size` seats (1 VS 1 to 4 VS 4), numbered team by team (P1-P3 against P4-P6 in
 * 3 VS 3); each seat is a pad of the game (@ssm/rules seatSlot: pad 1 is the first seat, it
 * drives the menus). Seats may stay empty (the CPU), and who has no seat watches.
 */
import { seatSlot } from '@ssm/rules';

export interface Member {
  peer: number;
  name: string;
}

export interface StartMsg {
  t: 'start';
  /** each seated player's session slot */
  players: { peer: number; slot: number }[];
  /** wrestlers a team (1-4) */
  size: number;
  delay: number;
  /** Ruleset id: every peer installs the same overrides */
  rules: string;
}

/** seats a team at most */
export const TEAM_SEATS = 4;
/** players in a match at most */
export const MAX_PLAYERS = 2 * TEAM_SEATS;

export class Room {
  readonly ws: WebSocket;
  me = -1;
  /** the room's name, as the server keeps it */
  code = '';
  members: Member[] = [];
  /** wrestlers a team (1-4), as the host set it */
  size = 2;
  /** seat team * TEAM_SEATS + place -> peer id (null: empty, the CPU); only `size` a team count */
  seats: (number | null)[] = Array<number | null>(MAX_PLAYERS).fill(null);
  /** round trip to the server, ms */
  ping = 0;
  onChange: () => void = () => {};
  onStart: (msg: StartMsg) => void = () => {};
  onBinary: (data: Uint8Array) => void = () => {};
  onLeave: (m: Member) => void = () => {};
  onClose: () => void = () => {};
  private timer = 0;

  constructor(code: string, name: string) {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      this.ws.send(JSON.stringify({ t: 'join', room: code, name }));
      this.timer = window.setInterval(() => this.ws.send(JSON.stringify({ t: 'ping', id: performance.now() })), 1000);
    };
    this.ws.onclose = () => {
      clearInterval(this.timer);
      this.onClose();
    };
    this.ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) return this.onBinary(new Uint8Array(e.data));
      const msg = JSON.parse(String(e.data));
      if (msg.t === 'joined') {
        this.me = msg.peer;
        this.code = msg.room;
        this.members = [...msg.peers, { peer: msg.peer, name }].sort((a, b) => a.peer - b.peer);
        this.fixSeats();
        this.onChange();
      } else if (msg.t === 'peer-join') {
        this.members = [...this.members, { peer: msg.peer, name: msg.name }].sort((a, b) => a.peer - b.peer);
        this.fixSeats();
        if (this.isHost) this.sendSeats(); // for the newcomer
        this.onChange();
      } else if (msg.t === 'peer-leave') {
        const m = this.members.find((x) => x.peer === msg.peer);
        this.members = this.members.filter((x) => x.peer !== msg.peer);
        this.fixSeats();
        this.onChange();
        if (m) this.onLeave(m);
      } else if (msg.t === 'pong') {
        this.ping = Math.round(performance.now() - msg.id);
      } else if (msg.t === 'seats') {
        if (msg.from !== this.members[0]?.peer) return; // only the host seats
        this.size = msg.size;
        this.seats = msg.seats;
        this.fixSeats();
        this.onChange();
      } else if (msg.t === 'start') {
        this.onStart(msg);
      }
    };
  }

  get isHost(): boolean {
    return this.members[0]?.peer === this.me;
  }

  /** The seats that count: each team's first `size`. */
  get open(): number[] {
    return [0, 1].flatMap((team) => Array.from({ length: this.size }, (_, place) => team * TEAM_SEATS + place));
  }

  /** The member in a seat. */
  seated(seat: number): Member | undefined {
    const p = this.seats[seat];
    return p === null || p === undefined ? undefined : this.members.find((m) => m.peer === p);
  }

  /** The members without a seat that counts. */
  get watching(): Member[] {
    const open = this.open;
    return this.members.filter((m) => !open.some((s) => this.seats[s] === m.peer));
  }

  /** The player number of a seat (P1 ...): team by team. */
  number(seat: number): number {
    const team = Math.floor(seat / TEAM_SEATS);
    return team * this.size + (seat % TEAM_SEATS) + 1;
  }

  /** Host: swap seats `a` and `b` (either may be empty). */
  swap(a: number, b: number): void {
    if (!this.isHost) return;
    const next = [...this.seats];
    [next[a], next[b]] = [next[b]!, next[a]!];
    this.seats = next;
    this.fixSeats();
    this.sendSeats();
    this.onChange();
  }

  /** Host: the team size; whoever loses a seat takes a free one, or watches. */
  setSize(size: number): void {
    if (!this.isHost) return;
    this.size = size;
    this.fixSeats();
    this.sendSeats();
    this.onChange();
  }

  /** Host: deal the seated players to the open seats at random. */
  shuffle(): void {
    if (!this.isHost) return;
    const open = this.open;
    const people = open.map((s) => this.seats[s]!).filter((p) => p !== null);
    const next = Array<number | null>(MAX_PLAYERS).fill(null);
    const free = [...open];
    for (let i = free.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [free[i], free[j]] = [free[j]!, free[i]!];
    }
    people.forEach((p, k) => (next[free[k]!] = p));
    // pad 1 drives the menus: its seat is never left empty
    if (next[0] === null) {
      const k = open.find((s) => next[s] !== null)!;
      [next[0], next[k]] = [next[k]!, null];
    }
    this.seats = next;
    this.fixSeats();
    this.sendSeats();
    this.onChange();
  }

  /**
   * Only present members sit, each once, in seats that count; the others (newcomers first)
   * fill the free ones, the emptier team first.
   */
  private fixSeats(): void {
    const open = this.open;
    const next = Array<number | null>(MAX_PLAYERS).fill(null);
    const seated = new Set<number>();
    for (const s of open) {
      const p = this.seats[s];
      if (p !== null && p !== undefined && !seated.has(p) && this.members.some((m) => m.peer === p)) {
        next[s] = p;
        seated.add(p);
      }
    }
    for (const m of this.members) {
      if (seated.has(m.peer)) continue;
      const count = (team: number) => open.filter((s) => Math.floor(s / TEAM_SEATS) === team && next[s] !== null).length;
      const free = open.filter((s) => next[s] === null).sort((a, b) => count(Math.floor(a / TEAM_SEATS)) - count(Math.floor(b / TEAM_SEATS)) || a - b);
      if (!free.length) break;
      next[free[0]!] = m.peer;
      seated.add(m.peer);
    }
    this.seats = next;
  }

  private sendSeats(): void {
    this.ws.send(JSON.stringify({ t: 'seats', seats: this.seats, size: this.size }));
  }

  /** Pad 1's seat (the first of team 1) is taken: the game can start. */
  get ready(): boolean {
    return this.seats[0] !== null && this.members.length > 1;
  }

  /** Host: start the match for everyone in the room (the host included). */
  start(delay: number, rules: string): void {
    const players = this.open
      .filter((s) => this.seats[s] !== null)
      .map((s) => ({ peer: this.seats[s]!, slot: seatSlot(this.size, Math.floor(s / TEAM_SEATS), s % TEAM_SEATS) }));
    const msg: StartMsg = { t: 'start', players, size: this.size, delay, rules };
    this.ws.send(JSON.stringify(msg));
    this.onStart(msg);
  }

  sendBinary(data: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  close(): void {
    clearInterval(this.timer);
    this.ws.onclose = null;
    this.ws.close();
  }
}
