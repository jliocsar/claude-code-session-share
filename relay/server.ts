// sshare relay: bridges (the host's terminal) push frames in, viewers watch.
// Viewers prove a link token over the socket; the relay keeps only its hash.
import { createHash, timingSafeEqual } from 'node:crypto'
import type { ServerWebSocket } from 'bun'

const SECRET = process.env.SSHARE_SECRET ?? ''
if (SECRET.length < 32) throw new Error('SSHARE_SECRET missing or too short')
const PORT = Number(process.env.PORT ?? 8000)
const DIST = new URL('./node_modules/ghostty-web/dist/', import.meta.url).pathname
const VIEWER = new URL('./viewer.html', import.meta.url).pathname
const HOST_GRACE_MS = 10 * 60_000
const MAX_DELTAS = 300
const MAX_PROMPT = 8000
const PROMPT_GAP_MS = 1500

type Mode = 'read' | 'edit'
type Tok = { mode: Mode; expires: number }
type Data =
  | { role: 'bridge'; sid: string }
  | { role: 'viewer'; sid: string; id: string; hash?: string; mode?: Mode; lastPrompt: number; authTimer?: Timer }
type WS = ServerWebSocket<Data>
type Sess = {
  bridge?: WS
  tokens: Map<string, Tok>
  full?: string
  deltas: string[]
  viewers: Set<WS>
  goneAt?: number
}

const sessions = new Map<string, Sess>()
const SID = /^[A-Za-z0-9_-]{8,32}$/
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const send = (ws: WS, o: unknown) => ws.send(JSON.stringify(o))

function secretOk(header: string | null) {
  const got = Buffer.from(header?.replace(/^Bearer /, '') ?? '')
  const want = Buffer.from(SECRET)
  return got.length === want.length && timingSafeEqual(got, want)
}

function session(sid: string) {
  let s = sessions.get(sid)
  if (!s) sessions.set(sid, (s = { tokens: new Map(), deltas: [], viewers: new Set() }))
  return s
}

function tellBridgeCounts(s: Sess) {
  if (!s.bridge) return
  let read = 0, edit = 0
  for (const v of s.viewers) if (v.data.role === 'viewer') v.data.mode === 'edit' ? edit++ : read++
  send(s.bridge, { type: 'viewers', read, edit })
}

function kick(s: Sess, pred: (v: WS) => boolean, reason: string) {
  for (const v of [...s.viewers]) {
    if (!pred(v)) continue
    send(v, { type: 'closed', reason })
    s.viewers.delete(v)
    v.close(4001, reason)
  }
  tellBridgeCounts(s)
}

function onBridge(ws: WS, s: Sess, m: any) {
  switch (m.type) {
    case 'hello':
      s.tokens = new Map((m.tokens ?? []).map((t: any) => [t.hash, { mode: t.mode, expires: t.expires }]))
      kick(s, v => v.data.role === 'viewer' && !!v.data.hash && !s.tokens.has(v.data.hash), 'link revoked')
      for (const v of s.viewers) send(v, { type: 'host', online: true })
      tellBridgeCounts(s)
      return
    case 'token.add':
      if (m.mode === 'read' || m.mode === 'edit') s.tokens.set(m.hash, { mode: m.mode, expires: m.expires })
      return
    case 'token.revoke':
      s.tokens.delete(m.hash)
      kick(s, v => v.data.role === 'viewer' && v.data.hash === m.hash, 'link revoked')
      return
    case 'end':
      kick(s, () => true, 'the host stopped sharing')
      sessions.delete(ws.data.sid)
      ws.close(1000, 'ended')
      return
    case 'frame': {
      const raw = JSON.stringify(m)
      if (m.full) {
        s.full = raw
        s.deltas = []
      } else if (s.full) {
        s.deltas.push(raw)
        if (s.deltas.length > MAX_DELTAS) send(ws, { type: 'resync' })
      }
      for (const v of s.viewers) v.send(raw)
      return
    }
    case 'queued':
      for (const v of s.viewers) if (v.data.role === 'viewer' && v.data.id === m.viewer) send(v, { type: 'queued', ok: m.ok, pending: m.pending, why: m.why })
      return
  }
}

function onViewer(ws: WS, s: Sess, m: any) {
  const d = ws.data
  if (d.role !== 'viewer') return
  if (!d.hash) {
    if (m.type !== 'auth' || typeof m.token !== 'string') return ws.close(4003, 'auth first')
    const hash = sha(m.token)
    const tok = s.tokens.get(hash)
    if (!tok || tok.expires < Date.now()) {
      send(ws, { type: 'closed', reason: 'this link is invalid or expired' })
      return ws.close(4003, 'bad token')
    }
    clearTimeout(d.authTimer)
    d.hash = hash
    d.mode = tok.mode
    s.viewers.add(ws)
    send(ws, { type: 'hello', mode: tok.mode, expires: tok.expires, online: !!s.bridge })
    if (s.full) {
      ws.send(s.full)
      for (const x of s.deltas) ws.send(x)
    }
    tellBridgeCounts(s)
    return
  }
  if (m.type !== 'prompt') return
  const tok = s.tokens.get(d.hash)
  if (!tok || tok.expires < Date.now()) return kick(s, v => v === ws, 'this link expired')
  if (tok.mode !== 'edit') return send(ws, { type: 'queued', ok: false, why: 'read-only link' })
  const text = String(m.text ?? '').trim()
  if (!text) return
  if (text.length > MAX_PROMPT) return send(ws, { type: 'queued', ok: false, why: `too long (max ${MAX_PROMPT})` })
  if (Date.now() - d.lastPrompt < PROMPT_GAP_MS) return send(ws, { type: 'queued', ok: false, why: 'slow down' })
  if (!s.bridge) return send(ws, { type: 'queued', ok: false, why: 'host is offline' })
  d.lastPrompt = Date.now()
  send(s.bridge, { type: 'prompt', text, viewer: d.id, hash: d.hash })
}

setInterval(() => {
  const now = Date.now()
  for (const [sid, s] of sessions) {
    for (const [h, t] of s.tokens) if (t.expires < now) {
      s.tokens.delete(h)
      kick(s, v => v.data.role === 'viewer' && v.data.hash === h, 'this link expired')
    }
    if (!s.bridge && s.goneAt && now - s.goneAt > HOST_GRACE_MS) {
      kick(s, () => true, 'the host went away')
      sessions.delete(sid)
    }
  }
}, 10_000)

const SEC_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' data:; img-src 'self' data:",
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
}

Bun.serve<Data, {}>({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url)
    const sid = url.searchParams.get('sid') ?? ''
    if (url.pathname === '/ws/bridge') {
      if (!SID.test(sid) || !secretOk(req.headers.get('authorization'))) return new Response('no', { status: 401 })
      return server.upgrade(req, { data: { role: 'bridge', sid } }) ? undefined : new Response('upgrade failed', { status: 400 })
    }
    if (url.pathname === '/ws/view') {
      if (!SID.test(sid)) return new Response('no', { status: 400 })
      const data = { role: 'viewer' as const, sid, id: crypto.randomUUID(), lastPrompt: 0 }
      return server.upgrade(req, { data }) ? undefined : new Response('upgrade failed', { status: 400 })
    }
    const m = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{8,32})\/?$/)
    if (m) return new Response(Bun.file(VIEWER), { headers: { ...SEC_HEADERS, 'content-type': 'text/html; charset=utf-8' } })
    const v = url.pathname.match(/^\/vendor\/([\w.-]+\.(js|wasm))$/)
    if (v) {
      const f = Bun.file(DIST + v[1])
      if (await f.exists()) return new Response(f, { headers: { 'cache-control': 'public, max-age=86400' } })
    }
    if (url.pathname === '/') return Response.json({ ok: "you're a teapot" }, { status: 418 })
    return new Response('not found\n', { status: 404 })
  },
  websocket: {
    maxPayloadLength: 4 * 1024 * 1024,
    open(ws) {
      const s = session(ws.data.sid)
      if (ws.data.role === 'bridge') {
        if (s.bridge && s.bridge !== ws) s.bridge.close(4000, 'replaced')
        s.bridge = ws
        s.goneAt = undefined
      } else {
        ws.data.authTimer = setTimeout(() => ws.close(4003, 'auth timeout'), 5000)
      }
    },
    message(ws, raw) {
      const s = sessions.get(ws.data.sid)
      if (!s) return ws.close(4004, 'no such session')
      let m: any
      try { m = JSON.parse(String(raw)) } catch { return }
      if (ws.data.role === 'bridge') onBridge(ws, s, m)
      else onViewer(ws, s, m)
    },
    close(ws) {
      const s = sessions.get(ws.data.sid)
      if (!s) return
      if (ws.data.role === 'bridge') {
        if (s.bridge !== ws) return
        s.bridge = undefined
        s.goneAt = Date.now()
        for (const v of s.viewers) send(v, { type: 'host', online: false })
      } else {
        clearTimeout(ws.data.authTimer)
        s.viewers.delete(ws)
        tellBridgeCounts(s)
        if (!s.bridge && s.viewers.size === 0 && s.tokens.size === 0) sessions.delete(ws.data.sid)
      }
    },
  },
})
console.log(`sshare relay on :${PORT}`)
