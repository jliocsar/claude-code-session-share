# claude-code-session-share

Share a live Claude Code TUI session as a public web link. The browser renders the real terminal with ghostty-web. Read links watch. Edit links also get a floating prompt box whose messages get queued into the session.

## Pieces

```
herdr pane --observe--> bridge (local, bun) --wss--> relay (exe.dev VM) --wss--> browser (ghostty-web)
   mod ($.prompt.submit) <-- bridge stdout <-- guest prompts <---------------------+
```

- `plugin/`: the Claude Code mod (function hooks plugin).
  - `hooks/`: the mod, one module (`register.tsx`) plus the files it imports.
    - `register.tsx`: the hooks. The `/share-session` command, and the `AbovePrompt` band (a dim "sharing session" line, or the approve prompt when a guest message waits).
    - `commands.ts`: parses and runs `/share-session` subcommands.
    - `control.ts`: the state atoms and every read or write of them, the bridge's control calls, and guest messages (hold, approve, reject).
    - `process.ts`: spawns the bridge with `$.process.spawn` and handles its stdout events.
    - `text.ts`: pure helpers: argument parsing, TTLs, the status line and the usage text.
  - `bridge/`: a Bun process. `bridge.ts` is the entry and serves the control API on a unix socket. `core.ts` holds the env, the shared state and `emit`/`send`. `links.ts` holds the link tokens. `herdr.ts` runs `herdr terminal session observe <pane>` and follows resizes. `relay.ts` keeps the relay socket.
  - `types/index.d.ts`: the `$.state` contract (`session-share.share`, `session-share.pending`). The validator wants it self-contained, so it can't re-export anything.
  - `types/protocol.d.ts`: every wire message between the four pieces, and the control routes (`Control`). The mod, the bridge, the relay, the viewer and the test all `import type` from it. Type-only imports vanish at runtime, which is why the relay deploys without it.
- `relay/`: a Bun server.
  - `server.ts` is the entry: routes and assets.
  - `sockets.ts` routes WebSocket messages, `session.ts` holds the session logic, and `schemas.ts` holds the valibot schemas every inbound message is parsed with.
  - The viewer page is `viewer.html`, `viewer.css` and `viewer.ts`. The server bundles `viewer.ts` with ghostty-web (wasm inlined) through `Bun.build` at startup and serves it as `/viewer.js`.
  - Styles come from oat (`@knadh/oat`) with its stock dark theme, served as `/vendor/oat.min.css`. `viewer.css` only forces dark mode and lays the page out.
  - The page has no inline script or style, so the CSP has no `'unsafe-inline'`.
- `test/e2e.ts`: end-to-end test. Starts a local relay on a random port with a throwaway secret, runs the real bridge on the current herdr pane, and drives fake viewers.
- `.claude-plugin/marketplace.json`: makes the repo installable with `/plugin install session-share --marketplace jliocsar/claude-code-session-share`.
- Root `package.json`: dev tooling only (oxlint, oxfmt, `@jliocsar/begone-slop`, typescript, `@types/bun`). `relay/package.json` is what the VM installs.
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

- `ready {sid, socket, page}`
- `relay {online}`
- `viewers {read, edit}`
- `prompt {text, viewer, approve}`
- `fatal {why}`

Mod to bridge: HTTP over the unix socket `$XDG_RUNTIME_DIR/session-share-<pid>.sock`, via `$.http.fetch(url, { socketPath })`. Every route is a POST with a JSON body, typed by `Control`.

- `/link {mode, ttlMs, approve}` returns `{mode, approve, url, expires}`. `ttlMs: null` means the default.
- `/links` (body `null`) returns `{links}`.
- `/revoke {mode}` (`mode: null` revokes all) returns `{revoked}`.
- `/queued {viewer, outcome, why?}` returns `{delivered}`.
- `/stop` (body `null`).

A delivery is `{outcome: 'sent'}`, `{outcome: 'pending'}` or `{outcome: 'refused', why}`.

Bridge and relay talk over `wss://<relay>/ws/bridge?sid=<sid>` with `Authorization: Bearer <secret>`.

- Bridge to relay: `hello {tokens:[{hash,mode,expires}]}`, `token.add`, `token.revoke {hash}`, `frame {...}`, `queued {viewer, outcome, why?}`, `end`.
- Relay to bridge: `prompt {text, viewer, hash}`, `viewers {read, edit}`, `resync`.

Viewer and relay talk over `wss://<relay>/ws/view?sid=<sid>`.

- The viewer sends `auth {token}` within 5s, then `prompt {text}`.
- The relay sends `hello {mode, expires, online}`, `frame`, `host {online}`, `queued {outcome, why?}` and `closed {reason}`.

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
cd relay && scp *.ts viewer.html viewer.css package.json bun.lock session-share.exe.xyz:relay/ \
  && ssh session-share.exe.xyz 'sudo systemctl restart session-share-relay && systemctl is-active session-share-relay'
```

If `package.json` changed, run `~/.bun/bin/bun install` in `~/relay` on the VM.

## Developing the mod

- There are two copies. `plugin/` is the repo copy. The session loads the dev-mods copy, at `~/.claude/dev-mods/<session-id>/session-share/` (it was `06d17896-8cde-428c-ab86-1f96aaf13fcf` when this was built). Edit one, then sync: `rsync -a --exclude .claude-plugin/types plugin/ ~/.claude/dev-mods/<session-id>/session-share/`, or the reverse. Dev-mods hot-reload when the turn ends.
- Tooling, from the repo root after `bun install` (and `bun install` in `relay/` for the test):
  - `bun run lint`: oxlint with the `@jliocsar/begone-slop` preset (`.oxlintrc.json`, same setup as the begone-slop repo, minus its Effect-only rules), then `oxfmt --check`. `bun run fix` writes. Style: 2 spaces, single quotes, no semicolons, 100 columns.
  - The preset bans comments (except `SAFETY:` ones on type assertions), `switch`, `typeof`, optional parameters and one-letter names. It also wants blank lines around blocks and returns, and top-level declarations ordered: imports, types, constants, functions, then `let`s. Files stay under 300 lines.
  - `bun run typecheck`: `tsc -p .` (relay server, bridge, test, with bun types), `tsc -p tsconfig.viewer.json` (the viewer, with DOM types) and `tsc -p plugin` (the mod). The root configs extend `@jliocsar/begone-slop/tsconfig` (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`).
  - `bun run check`: lint + typecheck + `claude plugin validate plugin`.
  - `bun run test`: the e2e test. Run it inside herdr.
- `tsc -p plugin` needs `plugin/.claude-plugin/types/`, which the engine writes into the loaded copy only. Copy it over: `rsync -a ~/.claude/dev-mods/<session-id>/session-share/.claude-plugin/types plugin/.claude-plugin/`. It's gitignored.
- The bridge and the mod ship without `node_modules`, so they have no runtime dependencies. They decode their trusted peers' JSON with a `SAFETY:`-justified assertion. Only the relay, which talks to strangers, parses with valibot.
- Mod API rules learned the hard way:
  - A function that receives `$` must be a top-level function declaration, in this file or imported from one of the mod's own files, or the validator refuses it. Helpers live at module top level, not inside `register`. Passing `$` through a lookup table (`COMMANDS.get(sub)($)`) is refused too, so command and event dispatch are plain `if`s.
  - `read`/`update` need an atom declared in the same file. That's why every state access goes through helpers in `control.ts`.
  - `$.ui.status`, `$.ui.toast` and `$.ui.log` return `void`. Don't await them.
  - Every `$.state` value is declared in `types/index.d.ts` as `Shaped<T>`.
  - `$.process.spawn`'s `input` is a one-shot string. That's why mod-to-bridge control goes over the unix socket instead of stdin.
  - Module variables reset on reload, and a reload kills the spawned bridge. `session.start` resets the state atoms.
  - Band `Button` hotkeys only work while the band has focus (ctrl+x tab or a click).
  - The command is registered `immediate: true`, so `/share-session` runs mid-turn.
  - The contract (`types/index.d.ts`) can't import or re-export. Other types come from `types/protocol.d.ts` directly.
  - `$.prompt.submit` settles when the turn runs, so the mod doesn't await it before acking the guest.
- The e2e test covers: link defaults and TTL clamp, the page's CSP, the bundled viewer script, late-join frames, bad tokens and unknown sessions (4003), viewer counts (one update per kick), read links refused, approve vs auto prompts, the pending ack, rate limiting, revoke and stop. It doesn't drive the mod itself (the band, `$.prompt.submit`).
- Visual check: start a bridge, make a link through the socket (`curl --unix-socket <sock> -X POST http://x/link -d '{"mode":"edit","ttlMs":null,"approve":true}'`), then open it with `agent-browser`.

## Known gaps

- The approve band hasn't been seen live yet. `/share-session edit` in auto mode was verified end to end.
- The viewer scales the terminal to fit and doesn't reflow it. On small screens the text gets tiny.
- Relay sessions are in memory only.
