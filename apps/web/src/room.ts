/**
 * A room on the server's WebSocket relay (/ws). The server only relays: the peer with the
 * lowest id is the host, and its `start` message fixes the players (slot order) and the input
 * delay for everyone.
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
        this.onChange();
      } else if (msg.t === 'peer-join') {
        this.members = [...this.members, { peer: msg.peer, name: msg.name }].sort((a, b) => a.peer - b.peer);
        this.onChange();
      } else if (msg.t === 'peer-leave') {
        const m = this.members.find((x) => x.peer === msg.peer);
        this.members = this.members.filter((x) => x.peer !== msg.peer);
        this.onChange();
        if (m) this.onLeave(m);
      } else if (msg.t === 'pong') {
        this.ping = Math.round(performance.now() - msg.id);
      } else if (msg.t === 'start') {
        this.onStart(msg);
      }
    };
  }

  get isHost(): boolean {
    return this.members[0]?.peer === this.me;
  }

  /** Host: start the match for everyone in the room (the host included). */
  start(delay: number, rules: string): void {
    const msg: StartMsg = { t: 'start', players: this.members.slice(0, 4).map((m) => m.peer), delay, rules };
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
