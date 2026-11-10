# claude-code-sshare

Share a live Claude Code TUI session as a web link. The page renders the real terminal with [ghostty-web](https://github.com/coder/ghostty-web). Read links watch; edit links also get a floating prompt box that sends messages into the session.

```
/sshare read [ttl]                          watch-only link (30m, 2h, 1d; default 2h)
/sshare edit [ttl] [--mode approve|auto]    can send prompts; approve (default) holds each for your ok
/sshare approve [all] | reject [all]        answer held guest messages
/sshare list | revoke [read|edit] | stop
```

## Setup

Requirements: Claude Code running inside a [herdr](https://herdr.dev) pane, `bun` on PATH.

1. Relay: put `relay/` on a host with a public HTTPS port, `bun install`, and run `bun server.ts` with `SSHARE_SECRET` (32+ chars) and optionally `PORT` (default 8000).
2. Locally: write the same secret to `~/.config/sshare/secret` (chmod 600). Set `SSHARE_RELAY=https://your-relay` if it isn't the default `https://sshare.exe.xyz`.
3. Install the mod, at the prompt of a terminal session:

```
/plugin install sshare --marketplace jliocsar/claude-code-sshare
```

From a shell: `claude plugin install sshare --marketplace jliocsar/claude-code-sshare`.


## How it works

```
herdr pane --observe--> bridge (local, bun) --wss--> relay (exe.dev VM) --wss--> browser (ghostty-web)
                         ^ stdout: guest prompts         ^ token check (sha256 only)
   mod ($.prompt.submit) <-+
```

- `plugin/`: the Claude Code mod. `/sshare` spawns `plugin/bridge/bridge.ts`, which runs `herdr terminal session observe <pane>` and pushes frames to the relay. Guest prompts come back on the bridge's stdout and the mod queues them with `$.prompt.submit`.
- `relay/`: a Bun server. Serves `/s/<sid>`, checks the link token over the websocket (it stores only its sha256), enforces read vs edit and expiry, and replays the last full frame to late joiners.

Links look like `https://<relay>/s/<sid>#t=<token>`. The token is in the fragment, so it never reaches a server in a request line, and the page drops it from the address bar once read.

## Security

An edit link in auto mode lets whoever holds it prompt your session with its tool permissions. Keep approve mode unless you trust the person. Read links show whatever is on screen, secrets included.

## Development

```sh
bun install && (cd relay && bun install)
bun run check   # biome, tsc, plugin validate
bun run test    # e2e against a local relay; run inside herdr
```
