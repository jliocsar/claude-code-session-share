# claude-code-session-share

Share a live Claude Code TUI session as a public web link. The browser renders the real terminal with ghostty-web. Read links watch. Edit links also get a floating prompt box whose messages get queued into the session.

## Pieces

```
herdr pane --observe--> bridge (local, bun) --wss--> relay (exe.dev VM) --wss--> browser (ghostty-web)
   mod ($.prompt.submit) <-- bridge stdout <-- guest prompts <---------------------+
```

- `plugin/`: the Claude Code mod (function hooks plugin).
  - `hooks/register.tsx`: `/share-session` command, the `AbovePrompt` band (a dim "sharing session" line, or the approve prompt when a guest message waits), status line, toasts. Spawns the bridge with `$.process.spawn` and reads its stdout.
  - `bridge/bridge.ts`: a Bun process. Runs `herdr terminal session observe <pane>`, pushes frames to the relay, holds the link tokens, and serves a control API on a unix socket.
  - `types/index.d.ts`: the `$.state` contract (`session-share.share`, `session-share.pending`). The validator wants it self-contained, so it can't re-export anything.
  - `types/protocol.d.ts`: every wire message between the four pieces. The mod, the bridge, the relay and the test all `import type` from it. Type-only imports vanish at runtime, which is why the relay deploys without it.
- `relay/`: a Bun server (`server.ts`) plus the viewer page (`viewer.html`, `viewer.js`, `viewer.css`). Serves ghostty-web from `node_modules/ghostty-web/dist` under `/vendor/`. The wasm is inlined in the JS. Its components come from oat (`@knadh/oat`), served as `/vendor/oat.min.css`. `viewer.css` only sets the theme variables and the layout. The page has no inline script or style, so the CSP has no `'unsafe-inline'`.
- `test/e2e.ts`: end-to-end test. Starts a local relay on a random port with a throwaway secret, runs the real bridge on the current herdr pane, and drives fake viewers.
- `.claude-plugin/marketplace.json`: makes the repo installable with `/plugin install session-share --marketplace jliocsar/claude-code-session-share`.
- Root `package.json`: dev tooling only (biome, typescript, `@types/bun`). `relay/package.json` is what the VM installs.
- `tmp/`: gitignored scratch (screenshots, the unpacked ghostty-web package, handoffs).

## Why herdr

A mod can't see the rendered TUI or listen on a port. Herdr fills that gap: `herdr terminal session observe <pane_id> --cols W --rows H` streams the pane as JSON lines:

```
{"type":"terminal.frame","encoding":"ansi","bytes":"<base64 ansi>","full":true,"width":201,"height":56,"seq":1}
```

It needs no TTY. A `full` frame clears the screen and redraws it. Without `--cols/--rows` it renders at 120x40, so the bridge reads the pane rect from `herdr pane layout --pane <id>` every 2s and restarts observe on a resize. The pane id comes from `HERDR_PANE_ID`, so the session has to run inside herdr.

## Protocols

The types live in `plugin/types/protocol.d.ts`. In short:

Bridge stdout to the mod (JSON lines):

- `ready {sid, socket}`
- `relay {online}`
- `viewers {read, edit}`
- `prompt {text, viewer, approve}`
- `fatal {why}`

Mod to bridge: HTTP over the unix socket `$XDG_RUNTIME_DIR/session-share-<pid>.sock`, via `$.http.fetch(url, { socketPath })`. Every route is a POST with a JSON body.

- `/link {mode, ttlMs, approve}` returns `{mode, approve, url, expires}`.
- `/links`
- `/revoke {mode?}`
- `/queued {viewer, ok, pending, why}`
- `/stop`

Bridge and relay talk over `wss://<relay>/ws/bridge?sid=<sid>` with `Authorization: Bearer <secret>`.

- Bridge to relay: `hello {tokens:[{hash,mode,expires}]}`, `token.add`, `token.revoke {hash}`, `frame {...}`, `queued {viewer, ok, pending, why}`, `end`.
- Relay to bridge: `prompt {text, viewer, hash}`, `viewers {read, edit}`, `resync`.

Viewer and relay talk over `wss://<relay>/ws/view?sid=<sid>`.

- The viewer sends `auth {token}` within 5s, then `prompt {text}`.
- The relay sends `hello {mode, expires, online}`, `frame`, `host {online}`, `queued {ok, pending, why}` and `closed {reason}`.

## Security model

- Links look like `https://session-share.exe.xyz/s/<sid>#t=<token>`.
- The token is 32 random bytes in the URL fragment, so it never reaches a server in a request line.
- The page moves the token into `sessionStorage` and strips it from the address bar.
- The relay stores only `sha256(token)`, and the mode and expiry are bound to the token on the server. A read token can never send prompts.
- The bridge is the source of truth for tokens. A relay restart loses its in-memory state, but the bridge reconnects and re-sends `hello`, so links survive.
- Relay limits:
  - prompts at most 8000 chars, at least 1.5s apart per viewer
  - 5s to authenticate
  - more than 300 cached delta frames triggers `resync`
  - a session is dropped 10 min after its host disconnects
- TTL is clamped to between 1m and 7d. The default is 2h.
- Edit links default to `--mode approve`: each guest message waits in a band above the prompt. Approve with `y`, reject with `n`, approve all with `a`, after ctrl+x tab focuses the band. `/share-session approve|reject [all]` does the same. `--mode auto` submits right away.
- Link tokens never go on screen, since viewers watch it. `/share-session read|edit` copies the full link to the clipboard (`$.ui.copy`) and prints it without its `#t=` part. It prints it whole, with a warning, only when the copy fails. `/share-session list` and the band show token-free URLs.
- Guest prompts go in framed as `[session-share guest via edit link]` (not `asUser`), so the model knows they didn't come from the owner.

## Infra

- Relay host: the exe.dev VM `session-share`, at https://session-share.exe.xyz, public proxy on port 8000.
  - The code lives in `~/relay` on the VM. `~/relay/.env` holds `SESSION_SHARE_SECRET` and `PORT`.
  - It runs as the systemd unit `session-share-relay` with Bun at `~/.bun/bin/bun`.
  - `/` answers `418 {"ok":"you're a teapot"}` on purpose.
- Local secret: `~/.config/session-share/secret` (chmod 600). It must match the relay's `SESSION_SHARE_SECRET`. Never commit it.
- `SESSION_SHARE_RELAY` overrides the default relay URL. `SESSION_SHARE_SECRET_FILE` overrides the secret path.

Deploy the relay:

```sh
cd relay && scp server.ts viewer.html viewer.js viewer.css package.json bun.lock session-share.exe.xyz:relay/ \
  && ssh session-share.exe.xyz 'sudo systemctl restart session-share-relay && systemctl is-active session-share-relay'
```

If `package.json` changed, run `~/.bun/bin/bun install` in `~/relay` on the VM.

## Developing the mod

- There are two copies. `plugin/` is the repo copy. The session loads the dev-mods copy, at `~/.claude/dev-mods/<session-id>/session-share/` (it was `06d17896-8cde-428c-ab86-1f96aaf13fcf` when this was built). Edit one, then sync: `rsync -a --exclude .claude-plugin/types plugin/ ~/.claude/dev-mods/<session-id>/session-share/`, or the reverse. Dev-mods hot-reload when the turn ends.
- Tooling, from the repo root after `bun install` (and `bun install` in `relay/` for the test):
  - `bun run lint`: biome (lint + format check; `bun run fix` writes). Style: 2 spaces, single quotes, no semicolons, 120 columns.
  - `bun run typecheck`: `tsc -p .` (relay, bridge, test, with bun types) and `tsc -p plugin` (the mod).
  - `bun run check`: lint + typecheck + `claude plugin validate plugin`.
  - `bun run test`: the e2e test. Run it inside herdr.
- `tsc -p plugin` needs `plugin/.claude-plugin/types/`, which the engine writes into the loaded copy only. Copy it over: `rsync -a ~/.claude/dev-mods/<session-id>/session-share/.claude-plugin/types plugin/.claude-plugin/`. It's gitignored.
- Don't run `biome migrate`: on 2.6 it rewrote `rules.recommended: true` to `preset: "none"`, which silently turns every rule off. The config uses `preset: "recommended"`.
- Mod API rules learned the hard way:
  - A function that receives `$` must be a top-level function declaration, or the validator refuses it. Helpers live at module top level, not inside `register`.
  - Every `$.state` value is declared in `types/index.d.ts` as `Shaped<T>`.
  - `$.process.spawn`'s `input` is a one-shot string. That's why mod-to-bridge control goes over the unix socket instead of stdin.
  - Module variables reset on reload, and a reload kills the spawned bridge. `session.start` resets the state atoms.
  - Band `Button` hotkeys only work while the band has focus (ctrl+x tab or a click).
  - The command is registered `immediate: true`, so `/share-session` runs mid-turn.
  - The contract (`types/index.d.ts`) can't import or re-export. Other types come from `types/protocol.d.ts` directly.
  - `$.prompt.submit` settles when the turn runs, so the mod doesn't await it before acking the guest.
- The e2e test covers: link defaults and TTL clamp, the page's CSP, late-join frames, bad tokens and unknown sessions (4003), viewer counts (one update per kick), read links refused, approve vs auto prompts, the pending ack, rate limiting, revoke and stop. It doesn't drive the mod itself (the band, `$.prompt.submit`).
- Visual check: start a bridge, make a link through the socket (`curl --unix-socket <sock> -X POST http://x/link -d '{"mode":"edit"}'`), then open it with `agent-browser`.

## Known gaps

- The approve band hasn't been seen live yet. `/share-session edit` in auto mode was verified end to end.
- The viewer scales the terminal to fit and doesn't reflow it. On small screens the text gets tiny.
- Relay sessions are in memory only.
