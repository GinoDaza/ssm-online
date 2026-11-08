# SSM Online

**Saturday Night Slam Masters** (SNES, Capcom, 1994), playable online with friends, plus modes
the original never had: ring-out in 2vs2, 4vs4 on a wider ring.

The game runs from its own code: the server holds your ROM dump, and the client translates the
ROM's 65816 code to JavaScript as it runs. There is no emulator. The fighting is the
original's, frame for frame. New modes replace single routines with TypeScript. No game data
is included in this repository.

## Run

Requirements: Node 22.12+ and your own dump of the USA ROM (see `roms/README.md`).

```sh
npm install
cp .env.example .env    # optional: ROM path, port
npm start               # builds the client and serves it on port 8790
```

The server prints its addresses. Friends on the same LAN or VPN (Radmin VPN works) open
`http://<address>:8790`. For development, `npm run dev` starts the same server with hot reload.

## Roadmap

- [x] Translated game: boots and runs, deterministic, checked against the emulator
- [ ] Cycle timing, so match frames match the emulator byte for byte
- [ ] Picture (PPU renderer) and controls: a local match in the browser
- [ ] Sound (SPC700 with the original driver)
- [ ] Online play with rollback netcode
- [ ] New modes: ring-out in 2vs2, 4vs4

See `docs/architecture.md` for how it works.
