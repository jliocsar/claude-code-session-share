# claude-code-sshare

Share a live Claude Code TUI session as a public web link. The browser renders the real terminal with ghostty-web. Read links watch. Edit links also get a floating prompt box whose messages get queued into the session.

## Pieces

```
herdr pane --observe--> bridge (local, bun) --wss--> relay (exe.dev VM) --wss--> browser (ghostty-web)
   mod ($.prompt.submit) <-- bridge stdout <-- guest prompts <---------------------+
```

- `plugin/`: the Claude Code mod (function hooks plugin).
  - `hooks/register.tsx`: `/sshare` command, the approve band (`AbovePrompt`), status line, toasts. Spawns the bridge with `$.process.spawn` and reads its stdout.
  - `bridge/bridge.ts`: a Bun process. Runs `herdr terminal session observe <pane>`, pushes frames to the relay, holds the link tokens, and serves a control API on a unix socket.
  - `types/index.d.ts`: the `$.state` contract (`sshare.share`, `sshare.pending`).
- `relay/`: a Bun server (`server.ts`) plus the viewer page (`viewer.html`). Serves ghostty-web from `node_modules/ghostty-web/dist` under `/vendor/`. The wasm is inlined in the JS.
- `.claude-plugin/marketplace.json`: makes the repo installable with `/plugin install sshare --marketplace jliocsar/claude-code-sshare`.
- `tmp/`: gitignored scratch. Holds `e2e.ts` (end-to-end smoke test), screenshots and the unpacked ghostty-web package.

## Why herdr

A mod can't see the rendered TUI or listen on a port. Herdr fills that gap: `herdr terminal session observe <pane_id> --cols W --rows H` streams the pane as JSON lines:

```
{"type":"terminal.frame","encoding":"ansi","bytes":"<base64 ansi>","full":true,"width":201,"height":56,"seq":1}
```

It needs no TTY. A `full` frame clears the screen and redraws it. Without `--cols/--rows` it renders at 120x40, so the bridge reads the pane rect from `herdr pane layout --pane <id>` every 2s and restarts observe on a resize. The pane id comes from `HERDR_PANE_ID`, so the session has to run inside herdr.

## Protocols

Bridge stdout to the mod (JSON lines):
- `ready {sid, socket}`
- `relay {online}`
- `viewers {read, edit}`
- `prompt {text, viewer, approve}`
- `fatal {why}`

Mod to bridge: HTTP over the unix socket `$XDG_RUNTIME_DIR/sshare-<pid>.sock`, via `$.http.fetch(url, { socketPath })`. Every route is a POST with a JSON body.
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

- Links look like `https://sshare.exe.xyz/s/<sid>#t=<token>`.
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
- Edit links default to `--mode approve`: each guest message waits in a band above the prompt. Approve with `y`, reject with `n`, approve all with `a`, after ctrl+x tab focuses the band. `/sshare approve|reject [all]` does the same. `--mode auto` submits right away.
- Guest prompts go in framed as `[sshare guest via edit link]` (not `asUser`), so the model knows they didn't come from the owner.

## Infra

- Relay host: the exe.dev VM `sshare`, at https://sshare.exe.xyz, public proxy on port 8000.
  - The code lives in `~/relay` on the VM. `~/relay/.env` holds `SSHARE_SECRET` and `PORT`.
  - It runs as the systemd unit `sshare-relay` with Bun at `~/.bun/bin/bun`.
  - `/` answers `418 {"ok":"you're a teapot"}` on purpose.
- Local secret: `~/.config/sshare/secret` (chmod 600). It must match the relay's `SSHARE_SECRET`. Never commit it.
- `SSHARE_RELAY` overrides the default relay URL. `SSHARE_SECRET_FILE` overrides the secret path.

Deploy the relay:

```sh
cd relay && scp server.ts viewer.html sshare.exe.xyz:relay/ \
  && ssh sshare.exe.xyz 'sudo systemctl restart sshare-relay && systemctl is-active sshare-relay'
```

If `package.json` changed, run `~/.bun/bin/bun install` in `~/relay` on the VM.

## Developing the mod

- There are two copies. `plugin/` is the repo copy. The session loads the dev-mods copy, at `~/.claude/dev-mods/<session-id>/sshare/` (it was `06d17896-8cde-428c-ab86-1f96aaf13fcf` when this was built). Edit one, then sync: `rsync -a --exclude .claude-plugin/types plugin/ ~/.claude/dev-mods/<session-id>/sshare/`, or the reverse. Dev-mods hot-reload when the turn ends.
- Check with `claude plugin validate plugin/`. Type-check with `tsc -p plugin` once the engine has laid `plugin/.claude-plugin/types/`. That folder is gitignored and the engine writes it.
- Mod API rules learned the hard way:
  - A function that receives `$` must be a top-level function declaration, or the validator refuses it. Helpers live at module top level, not inside `register`.
  - Every `$.state` value is declared in `types/index.d.ts` as `Shaped<T>`.
  - `$.process.spawn`'s `input` is a one-shot string. That's why mod-to-bridge control goes over the unix socket instead of stdin.
  - Module variables reset on reload, and a reload kills the spawned bridge. `session.start` resets the state atoms.
  - Band `Button` hotkeys only work while the band has focus (ctrl+x tab or a click).
  - The command is registered `immediate: true`, so `/sshare` runs mid-turn.
- Smoke test: `bun tmp/e2e.ts`, run inside herdr. It spawns a bridge, makes read and edit links, and drives fake viewers. It covers a bad token, a prompt refused on a read link, the edit prompt ack, revoke and stop. The test hardcodes the dev-mods path.
- Visual check: start a bridge, make a link through the socket (`curl --unix-socket <sock> -X POST http://x/link -d '{"mode":"edit"}'`), then open it with `agent-browser`.

## Known gaps

- The approve band hasn't been seen live yet. `/sshare edit` in auto mode was verified end to end.
- The relay sends the bridge duplicate `viewers` counts. They're harmless, because the mod only toasts on an increase.
- The viewer scales the terminal to fit and doesn't reflow it. On small screens the text gets tiny.
- Relay sessions are in memory only.
- There's no LICENSE yet.
