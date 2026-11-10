// sshare bridge: streams a herdr pane to the relay and hands guest prompts to the mod.
// stdout: one BridgeEvent JSON line per event. Control: HTTP over a unix socket.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import type { BridgeEvent, BridgeToRelay, LinkView, Mode, RelayToBridge } from '../types/protocol'

const PANE = process.env.SSHARE_PANE ?? ''
const RELAY = (process.env.SSHARE_RELAY ?? 'https://sshare.exe.xyz').replace(/\/$/, '')
const SECRET_FILE = process.env.SSHARE_SECRET_FILE ?? `${homedir()}/.config/sshare/secret`

// The mod accepts any `<n>m|h|d`; this is the one place a TTL gets clamped.
const TTL_DEFAULT = 2 * 3_600_000
const TTL_MIN = 60_000
const TTL_MAX = 7 * 86_400_000

const emit = (e: BridgeEvent) => process.stdout.write(`${JSON.stringify(e)}\n`)

function fail(why: string): never {
  emit({ type: 'fatal', why })
  process.exit(1)
}

function parse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function* lines(stream: ReadableStream<Uint8Array>) {
  const dec = new TextDecoder()
  let buf = ''
  for await (const chunk of stream) {
    const parts = (buf + dec.decode(chunk, { stream: true })).split('\n')
    buf = parts.pop() ?? ''
    for (const line of parts) if (line) yield line
  }
}

if (!PANE) fail('no herdr pane (is this session running inside herdr?)')
if (!existsSync(SECRET_FILE)) fail(`no relay secret at ${SECRET_FILE}`)
const SECRET = readFileSync(SECRET_FILE, 'utf8').trim()

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const sid = randomBytes(9).toString('base64url')
const sock = `${process.env.XDG_RUNTIME_DIR ?? '/tmp'}/sshare-${process.pid}.sock`
let stopping = false

// ---- links

type Link = LinkView & { token: string; hash: string }
const links = new Map<string, Link>()

const view = ({ mode, approve, url, expires }: Link): LinkView => ({ mode, approve, url, expires })
const tokenList = () => [...links.values()].map(({ hash, mode, expires }) => ({ hash, mode, expires }))

function addLink(mode: Mode, ttlMs: number, approve: boolean) {
  const token = randomBytes(32).toString('base64url')
  const link: Link = {
    mode,
    approve,
    token,
    hash: sha(token),
    expires: Date.now() + ttlMs,
    url: `${RELAY}/s/${sid}#t=${token}`,
  }
  links.set(link.hash, link)
  toRelay({ type: 'token.add', hash: link.hash, mode, expires: link.expires })
  return link
}

function revoke(pred: (l: Link) => boolean) {
  let n = 0
  for (const l of [...links.values()]) {
    if (!pred(l)) continue
    links.delete(l.hash)
    toRelay({ type: 'token.revoke', hash: l.hash })
    n++
  }
  return n
}

function clampTtl(ms: unknown) {
  return Math.min(Math.max(Number(ms) || TTL_DEFAULT, TTL_MIN), TTL_MAX)
}

// ---- relay socket, reconnecting

let ws: WebSocket | undefined
let online = false
let backoff = 500

function toRelay(m: BridgeToRelay) {
  if (online) ws?.send(JSON.stringify(m))
}

function onRelay(m: RelayToBridge) {
  switch (m.type) {
    case 'prompt':
      return emit({ type: 'prompt', text: m.text, viewer: m.viewer, approve: links.get(m.hash)?.approve ?? true })
    case 'viewers':
      return emit({ type: 'viewers', read: m.read, edit: m.edit })
    case 'resync':
      return restartObserve()
  }
}

function connect() {
  const url = `${RELAY.replace(/^http/, 'ws')}/ws/bridge?sid=${sid}`
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${SECRET}` } })
  ws = socket
  socket.onopen = () => {
    online = true
    backoff = 500
    toRelay({ type: 'hello', tokens: tokenList() })
    restartObserve() // a fresh full frame for the relay's cache
    emit({ type: 'relay', online: true })
  }
  socket.onmessage = ev => {
    const m = parse<RelayToBridge>(String(ev.data))
    if (m) onRelay(m)
  }
  // an error is always followed by close, which retries
  socket.onerror = () => {}
  socket.onclose = () => {
    if (online) emit({ type: 'relay', online: false })
    online = false
    if (stopping) return
    // refused or replaced sockets retry too: the relay may just be restarting
    setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, 15_000)
  }
}

// ---- herdr observe, restarted on resize

type HerdrFrame = { type: string; bytes: string; full: boolean; width: number; height: number; seq: number }
type HerdrLayout = { result: { layout: { panes: { pane_id: string; rect: { width: number; height: number } }[] } } }

let observer: Bun.Subprocess | undefined
let size = { w: 0, h: 0 }

async function paneSize() {
  const p = Bun.spawn(['herdr', 'pane', 'layout', '--pane', PANE], { stdout: 'pipe', stderr: 'ignore' })
  const layout = parse<HerdrLayout>(await new Response(p.stdout).text())
  const rect = layout?.result?.layout?.panes?.find(x => x.pane_id === PANE)?.rect
  return rect && { w: rect.width, h: rect.height }
}

function restartObserve() {
  observer?.kill()
  observer = undefined
  if (!size.w || stopping) return
  const argv = ['herdr', 'terminal', 'session', 'observe', PANE, '--cols', String(size.w), '--rows', String(size.h)]
  const p = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
  observer = p
  void pump(p)
}

async function pump(p: { stdout: ReadableStream<Uint8Array>; exited: Promise<number> }) {
  for await (const line of lines(p.stdout)) {
    const f = parse<HerdrFrame>(line)
    if (f?.type !== 'terminal.frame') continue
    toRelay({ type: 'frame', bytes: f.bytes, full: f.full, width: f.width, height: f.height, seq: f.seq })
  }
  await p.exited
  // died on its own, not through restartObserve: bring it back
  if (observer === p && !stopping) setTimeout(restartObserve, 1000)
}

async function watchSize() {
  const s = await paneSize()
  if (!s) {
    if (!size.w) fail(`herdr pane ${PANE} not found`)
    return
  }
  if (s.w === size.w && s.h === size.h) return
  size = s
  restartObserve()
}

// ---- control socket for the mod

function stop() {
  stopping = true
  toRelay({ type: 'end' })
  observer?.kill()
  setTimeout(() => {
    removeSocket()
    process.exit(0)
  }, 300)
}

function removeSocket() {
  try {
    unlinkSync(sock)
  } catch {}
}

type Body = Record<string, unknown>
const routes: Record<string, (b: Body) => unknown> = {
  '/link': b => view(addLink(b.mode === 'edit' ? 'edit' : 'read', clampTtl(b.ttlMs), b.approve !== false)),
  '/links': () => ({ sid, relay: online, links: [...links.values()].map(view) }),
  '/revoke': b => ({ revoked: revoke(l => !b.mode || l.mode === b.mode) }),
  '/queued': b => {
    const why = typeof b.why === 'string' ? b.why : undefined
    toRelay({ type: 'queued', viewer: String(b.viewer), ok: b.ok === true, pending: b.pending === true, why })
    return {}
  },
  '/stop': () => {
    stop()
    return { stopped: true }
  },
}

removeSocket()
Bun.serve({
  unix: sock,
  async fetch(req) {
    const route = routes[new URL(req.url).pathname]
    if (!route) return new Response('not found', { status: 404 })
    const body = (await req.json().catch(() => ({}))) as Body
    return Response.json(route(body))
  },
})

// expire links here too; the relay enforces the same deadline
setInterval(() => revoke(l => l.expires < Date.now()), 10_000)
// follow pane resizes, and quit if the mod's process went away (we got reparented)
const parent = process.ppid
setInterval(() => (process.ppid === parent ? void watchSize() : stop()), 2000)
process.on('SIGTERM', stop)
process.on('SIGINT', stop)

await watchSize()
connect()
emit({ type: 'ready', sid, socket: sock, page: `${RELAY}/s/${sid}` })
