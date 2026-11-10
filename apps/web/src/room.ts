/**
 * A room on the server's WebSocket relay (/ws). The server only relays: the peer with the
 * lowest id is the host, and its `start` message fixes the players (slot order) and the input
 * delay for everyone. Before the start the host can reorder the players (`order` messages): the
 * slot is the pad, and in Team Battle Royal pads 1 and 3 play against pads 2 and 4.
 */
export interface Member {
  peer: number;
  name: string;
}

export interface StartMsg {
  t: 'start';
  /** peer ids in slot order */
  players: number[];
  delay: number;
  /** Ruleset id: every peer installs the same overrides */
  rules: string;
}

export class Room {
  readonly ws: WebSocket;
  me = -1;
  /** the room's name, as the server keeps it */
  code = '';
  members: Member[] = [];
  /** peer ids in slot order, as the host set them; every member appears once */
  order: number[] = [];
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
        this.fixOrder(this.order);
        this.onChange();
      } else if (msg.t === 'peer-join') {
        this.members = [...this.members, { peer: msg.peer, name: msg.name }].sort((a, b) => a.peer - b.peer);
        this.fixOrder(this.order);
        if (this.isHost) this.ws.send(JSON.stringify({ t: 'order', players: this.order })); // for the newcomer
        this.onChange();
      } else if (msg.t === 'peer-leave') {
        const m = this.members.find((x) => x.peer === msg.peer);
        this.members = this.members.filter((x) => x.peer !== msg.peer);
        this.fixOrder(this.order);
        this.onChange();
        if (m) this.onLeave(m);
      } else if (msg.t === 'pong') {
        this.ping = Math.round(performance.now() - msg.id);
      } else if (msg.t === 'order') {
        if (msg.from !== this.members[0]?.peer) return; // only the host orders
        this.fixOrder(msg.players);
        this.onChange();
      } else if (msg.t === 'start') {
        this.onStart(msg);
      }
    };
  }

  get isHost(): boolean {
    return this.members[0]?.peer === this.me;
  }

  /** The members in slot order. */
  get ordered(): Member[] {
    return this.order.map((p) => this.members.find((m) => m.peer === p)!);
  }

  /** Host: swap the players in slots `a` and `b` and tell the room. */
  swap(a: number, b: number): void {
    const pa = this.order[a];
    const pb = this.order[b];
    if (!this.isHost || pa === undefined || pb === undefined) return;
    const next = [...this.order];
    next[a] = pb;
    next[b] = pa;
    this.fixOrder(next);
    this.ws.send(JSON.stringify({ t: 'order', players: this.order }));
    this.onChange();
  }

  /** Host: deal the four playing slots at random (the watchers keep their places). */
  shuffle(): void {
    if (!this.isHost) return;
    const next = [...this.order];
    const n = Math.min(4, next.length);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [next[i], next[j]] = [next[j]!, next[i]!];
    }
    this.fixOrder(next);
    this.ws.send(JSON.stringify({ t: 'order', players: this.order }));
    this.onChange();
  }

  /** `order` restricted to the present members, newcomers appended in join order. */
  private fixOrder(order: number[]): void {
    const present = order.filter((p) => this.members.some((m) => m.peer === p));
    this.order = [...present, ...this.members.map((m) => m.peer).filter((p) => !present.includes(p))];
  }

  /** Host: start the match for everyone in the room (the host included). */
  start(delay: number, rules: string): void {
    const msg: StartMsg = { t: 'start', players: this.order.slice(0, 4), delay, rules };
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
