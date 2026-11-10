// sshare bridge: streams a herdr pane to the relay, hands guest prompts to the mod.
// stdout: one JSON line per event for the mod. control: HTTP over a unix socket.
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, unlinkSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'

const PANE = process.env.SSHARE_PANE ?? ''
const RELAY = (process.env.SSHARE_RELAY ?? 'https://sshare.exe.xyz').replace(/\/$/, '')
const SECRET_FILE = process.env.SSHARE_SECRET_FILE ?? `${homedir()}/.config/sshare/secret`
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n')
const fail = (why: string) => { out({ type: 'fatal', why }); process.exit(1) }

if (!PANE) fail('no herdr pane (is this session running inside herdr?)')
if (!existsSync(SECRET_FILE)) fail(`no relay secret at ${SECRET_FILE}`)
const SECRET = readFileSync(SECRET_FILE, 'utf8').trim()

const b64url = (b: Buffer) => b.toString('base64url')
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const sid = b64url(randomBytes(9))
const sock = `${process.env.XDG_RUNTIME_DIR ?? '/tmp'}/sshare-${process.pid}.sock`

type Mode = 'read' | 'edit'
type Link = { mode: Mode; approve: boolean; token: string; hash: string; expires: number; url: string }
const links = new Map<string, Link>()

// ---- relay socket, reconnecting
let ws: WebSocket | undefined
let wsOpen = false
let backoff = 500
const toRelay = (o: unknown) => { if (wsOpen) ws!.send(JSON.stringify(o)) }
const tokenList = () => [...links.values()].map(l => ({ hash: l.hash, mode: l.mode, expires: l.expires }))

function connect() {
  const url = RELAY.replace(/^http/, 'ws') + `/ws/bridge?sid=${sid}`
  ws = new WebSocket(url, { headers: { authorization: `Bearer ${SECRET}` } } as any)
  ws.onopen = () => {
    wsOpen = true
    backoff = 500
    toRelay({ type: 'hello', tokens: tokenList() })
    restartObserve() // a fresh full frame for the relay's cache
    out({ type: 'relay', online: true })
  }
  ws.onmessage = ev => {
    let m: any
    try { m = JSON.parse(String(ev.data)) } catch { return }
    if (m.type === 'prompt') out({ type: 'prompt', text: m.text, viewer: m.viewer, approve: links.get(m.hash)?.approve ?? true })
    else if (m.type === 'viewers') out({ type: 'viewers', read: m.read, edit: m.edit })
    else if (m.type === 'resync') restartObserve()
  }
  ws.onclose = ev => {
    if (wsOpen) out({ type: 'relay', online: false })
    wsOpen = false
    if (stopping) return
    if (ev.code === 1008 || ev.code === 4000) {} // replaced or refused: still retry
    setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, 15_000)
  }
  ws.onerror = () => {}
}

// ---- herdr observe, restarted on resize
let observer: ReturnType<typeof Bun.spawn> | undefined
let size = { w: 0, h: 0 }

async function paneSize() {
  const p = Bun.spawn(['herdr', 'pane', 'layout', '--pane', PANE], { stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(p.stdout).text()
  try {
    const j = JSON.parse(text)
    const me = j.result.layout.panes.find((x: any) => x.pane_id === PANE)
    return me ? { w: me.rect.width, h: me.rect.height } : undefined
  } catch { return undefined }
}

function restartObserve() {
  observer?.kill()
  observer = undefined
  if (!size.w || stopping) return
  const p = Bun.spawn(['herdr', 'terminal', 'session', 'observe', PANE, '--cols', String(size.w), '--rows', String(size.h)], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'ignore',
  })
  observer = p
  ;(async () => {
    let buf = ''
    const dec = new TextDecoder()
    for await (const chunk of p.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (!line) continue
        try {
          const f = JSON.parse(line)
          if (f.type === 'terminal.frame') toRelay({ type: 'frame', bytes: f.bytes, full: f.full, width: f.width, height: f.height, seq: f.seq })
        } catch {}
      }
    }
    await p.exited
    if (observer === p && !stopping) setTimeout(restartObserve, 1000)
  })()
}

async function watchSize() {
  const s = await paneSize()
  if (!s) {
    if (!size.w) fail(`herdr pane ${PANE} not found`)
    return
  }
  if (s.w !== size.w || s.h !== size.h) {
    size = s
    restartObserve()
  }
}

// ---- links
function addLink(mode: Mode, ttlMs: number, approve: boolean) {
  const token = b64url(randomBytes(32))
  const l: Link = { mode, approve, token, hash: sha(token), expires: Date.now() + ttlMs, url: `${RELAY}/s/${sid}#t=${token}` }
  links.set(l.hash, l)
  toRelay({ type: 'token.add', hash: l.hash, mode, expires: l.expires })
  return l
}
function revoke(pred: (l: Link) => boolean) {
  let n = 0
  for (const l of [...links.values()]) if (pred(l)) {
    links.delete(l.hash)
    toRelay({ type: 'token.revoke', hash: l.hash })
    n++
  }
  return n
}
const view = (l: Link) => ({ mode: l.mode, approve: l.approve, url: l.url, expires: l.expires })

// ---- control socket for the mod
let stopping = false
async function stop() {
  stopping = true
  toRelay({ type: 'end' })
  observer?.kill()
  setTimeout(() => { try { unlinkSync(sock) } catch {}; process.exit(0) }, 300)
}

try { unlinkSync(sock) } catch {}
Bun.serve({
  unix: sock,
  async fetch(req) {
    const url = new URL(req.url)
    const body: any = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
    if (url.pathname === '/link') {
      const mode: Mode = body.mode === 'edit' ? 'edit' : 'read'
      const ttl = Math.min(Math.max(Number(body.ttlMs) || 2 * 3600_000, 60_000), 7 * 24 * 3600_000)
      return Response.json(view(addLink(mode, ttl, body.approve !== false)))
    }
    if (url.pathname === '/links') return Response.json({ sid, relay: wsOpen, links: [...links.values()].map(view) })
    if (url.pathname === '/revoke') {
      const n = revoke(l => !body.mode || l.mode === body.mode)
      return Response.json({ revoked: n })
    }
    if (url.pathname === '/queued') {
      toRelay({ type: 'queued', viewer: body.viewer, ok: !!body.ok, pending: !!body.pending, why: body.why })
      return Response.json({})
    }
    if (url.pathname === '/stop') { void stop(); return Response.json({ stopped: true }) }
    return new Response('not found', { status: 404 })
  },
})

// expire links locally too; the relay enforces the same deadline
setInterval(() => revoke(l => l.expires < Date.now()), 10_000)
// size changes and orphan check (parent gone -> reparented)
const parent = process.ppid
setInterval(() => {
  if (process.ppid !== parent) void stop()
  else void watchSize()
}, 2000)
process.on('SIGTERM', () => void stop())
process.on('SIGINT', () => void stop())

await watchSize()
connect()
out({ type: 'ready', sid, socket: sock })
