# session-share

The Claude Code mod half of claude-code-session-share: `/share-session read|edit [ttl] [--mode approve|auto]` shares this session as a live web link rendered with ghostty-web, through a relay. Edit links let the holder send prompts; in approve mode (the default) each waits in a band above your prompt for y/n.

Needs the session inside a herdr pane, `bun` on PATH, and a relay secret at `~/.config/session-share/secret`. See the repository README for the relay and setup.

```
/plugin install session-share --marketplace jliocsar/claude-code-session-share
```
