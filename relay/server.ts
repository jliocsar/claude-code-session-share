// sshare relay: bridges (the host's terminal) push frames in, viewers watch.
// Viewers prove a link token over the socket; the relay keeps only its hash.
import { createHash, timingSafeEqual } from 'node:crypto'
import type { ServerWebSocket } from 'bun'
import type { BridgeToRelay, Mode, RelayToBridge, RelayToViewer } from '../plugin/types/protocol'

const SECRET = process.env.SSHARE_SECRET ?? ''
if (SECRET.length < 32) throw new Error('SSHARE_SECRET missing or too short')
const PORT = Number(process.env.PORT ?? 8000)
const DIST = new URL('./node_modules/ghostty-web/dist/', import.meta.url).pathname
const PAGES: Record<string, { file: string; type: string }> = {
  html: { file: new URL('./viewer.html', import.meta.url).pathname, type: 'text/html; charset=utf-8' },
  js: { file: new URL('./viewer.js', import.meta.url).pathname, type: 'text/javascript; charset=utf-8' },
}
const HOST_GRACE_MS = 10 * 60_000
const AUTH_MS = 5000
const MAX_DELTAS = 300
const MAX_PROMPT = 8000
const PROMPT_GAP_MS = 1500
const SID = /^[A-Za-z0-9_-]{8,32}$/

type BridgeData = { role: 'bridge'; sid: string }
type ViewerData = {
  role: 'viewer'
  sid: string
  id: string
  hash?: string
  mode?: Mode
  lastPrompt: number
  authTimer?: Timer
}
type BridgeWS = ServerWebSocket<BridgeData>
type ViewerWS = ServerWebSocket<ViewerData>
type WS = ServerWebSocket<BridgeData | ViewerData>
type Session = {
  bridge?: BridgeWS
  tokens: Map<string, { mode: Mode; expires: number }>
  full?: string
  deltas: string[]
  viewers: Set<ViewerWS>
  goneAt?: number
}

// Only a bridge creates a session, so random sids never allocate anything.
const sessions = new Map<string, Session>()

const isBridge = (ws: WS): ws is BridgeWS => ws.data.role === 'bridge'
const isViewer = (ws: WS): ws is ViewerWS => ws.data.role === 'viewer'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const tell = (ws: ViewerWS, m: RelayToViewer) => ws.send(JSON.stringify(m))
const tellBridge = (ws: BridgeWS, m: RelayToBridge) => ws.send(JSON.stringify(m))

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const m = JSON.parse(text)
    return m && typeof m === 'object' ? m : undefined
  } catch {
    return undefined
  }
}

function secretOk(header: string | null) {
  const got = Buffer.from(header?.replace(/^Bearer /, '') ?? '')
  const want = Buffer.from(SECRET)
  return got.length === want.length && timingSafeEqual(got, want)
}

function tellCounts(s: Session) {
  if (!s.bridge) return
  let edit = 0
  for (const v of s.viewers) if (v.data.mode === 'edit') edit++
  tellBridge(s.bridge, { type: 'viewers', read: s.viewers.size - edit, edit })
}

// Kicked viewers leave the set here, so their close event doesn't count them again.
function kick(s: Session, pred: (v: ViewerWS) => boolean, reason: string) {
  let n = 0
  for (const v of [...s.viewers]) {
    if (!pred(v)) continue
    tell(v, { type: 'closed', reason })
    s.viewers.delete(v)
    v.close(4001, reason)
    n++
  }
  if (n) tellCounts(s)
}

function refuse(ws: ViewerWS, reason: string) {
  tell(ws, { type: 'closed', reason })
  ws.close(4003, reason)
}

function onBridge(ws: BridgeWS, s: Session, m: BridgeToRelay, raw: string) {
  switch (m.type) {
    case 'hello':
      s.tokens = new Map(m.tokens.map(t => [t.hash, { mode: t.mode, expires: t.expires }]))
      kick(s, v => !!v.data.hash && !s.tokens.has(v.data.hash), 'link revoked')
      for (const v of s.viewers) tell(v, { type: 'host', online: true })
      tellCounts(s)
      return
    case 'token.add':
      s.tokens.set(m.hash, { mode: m.mode, expires: m.expires })
      return
    case 'token.revoke':
      s.tokens.delete(m.hash)
      kick(s, v => v.data.hash === m.hash, 'link revoked')
      return
    case 'end':
      kick(s, () => true, 'the host stopped sharing')
      sessions.delete(ws.data.sid)
      ws.close(1000, 'ended')
      return
    case 'frame':
      if (m.full) {
        s.full = raw
        s.deltas = []
      } else if (s.full) {
        s.deltas.push(raw)
        if (s.deltas.length > MAX_DELTAS) tellBridge(ws, { type: 'resync' })
      }
      for (const v of s.viewers) v.send(raw)
      return
    case 'queued':
      for (const v of s.viewers) {
        if (v.data.id === m.viewer) tell(v, { type: 'queued', ok: m.ok, pending: m.pending, why: m.why })
      }
      return
  }
}

function auth(ws: ViewerWS, s: Session, token: unknown) {
  if (typeof token !== 'string') return refuse(ws, 'auth first')
  const hash = sha(token)
  const tok = s.tokens.get(hash)
  if (!tok || tok.expires < Date.now()) return refuse(ws, 'this link is invalid or expired')
  clearTimeout(ws.data.authTimer)
  ws.data.hash = hash
  ws.data.mode = tok.mode
  s.viewers.add(ws)
  tell(ws, { type: 'hello', mode: tok.mode, expires: tok.expires, online: !!s.bridge })
  if (s.full) for (const x of [s.full, ...s.deltas]) ws.send(x)
  tellCounts(s)
}

function prompt(ws: ViewerWS, s: Session, hash: string, input: unknown) {
  const no = (why: string) => tell(ws, { type: 'queued', ok: false, why })
  const tok = s.tokens.get(hash)
  if (!tok || tok.expires < Date.now()) return kick(s, v => v === ws, 'this link expired')
  if (tok.mode !== 'edit') return no('read-only link')
  const text = String(input ?? '').trim()
  if (!text) return
  if (text.length > MAX_PROMPT) return no(`too long (max ${MAX_PROMPT})`)
  if (Date.now() - ws.data.lastPrompt < PROMPT_GAP_MS) return no('slow down')
  if (!s.bridge) return no('host is offline')
  ws.data.lastPrompt = Date.now()
  tellBridge(s.bridge, { type: 'prompt', text, viewer: ws.data.id, hash })
}

function onViewer(ws: ViewerWS, s: Session | undefined, m: Record<string, unknown>) {
  if (!s) return refuse(ws, 'this link is invalid or expired')
  if (!ws.data.hash) return auth(ws, s, m.type === 'auth' ? m.token : undefined)
  if (m.type === 'prompt') prompt(ws, s, ws.data.hash, m.text)
}

setInterval(() => {
  const now = Date.now()
  for (const [sid, s] of sessions) {
    for (const [hash, t] of s.tokens) {
      if (t.expires >= now) continue
      s.tokens.delete(hash)
      kick(s, v => v.data.hash === hash, 'this link expired')
    }
    if (!s.bridge && s.goneAt && now - s.goneAt > HOST_GRACE_MS) {
      kick(s, () => true, 'the host went away')
      sessions.delete(sid)
    }
  }
}, 10_000)

const SEC_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' data:; img-src 'self' data:",
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
}

function page(kind: 'html' | 'js') {
  const p = PAGES[kind]
  if (!p) return new Response('not found\n', { status: 404 })
  return new Response(Bun.file(p.file), { headers: { ...SEC_HEADERS, 'content-type': p.type } })
}

Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url)
    const sid = url.searchParams.get('sid') ?? ''
    if (url.pathname === '/ws/bridge') {
      if (!SID.test(sid) || !secretOk(req.headers.get('authorization'))) return new Response('no', { status: 401 })
      if (server.upgrade(req, { data: { role: 'bridge', sid } })) return
      return new Response('upgrade failed', { status: 400 })
    }
    if (url.pathname === '/ws/view') {
      if (!SID.test(sid)) return new Response('no', { status: 400 })
      if (server.upgrade(req, { data: { role: 'viewer', sid, id: crypto.randomUUID(), lastPrompt: 0 } })) return
      return new Response('upgrade failed', { status: 400 })
    }
    if (/^\/s\/[A-Za-z0-9_-]{8,32}\/?$/.test(url.pathname)) return page('html')
    if (url.pathname === '/viewer.js') return page('js')
    const vendor = url.pathname.match(/^\/vendor\/([\w.-]+\.(js|wasm))$/)
    if (vendor) {
      const f = Bun.file(DIST + vendor[1])
      if (await f.exists()) return new Response(f, { headers: { 'cache-control': 'public, max-age=86400' } })
    }
    if (url.pathname === '/') return Response.json({ ok: "you're a teapot" }, { status: 418 })
    return new Response('not found\n', { status: 404 })
  },
  websocket: {
    data: {} as BridgeData | ViewerData,
    maxPayloadLength: 4 * 1024 * 1024,
    open(ws) {
      if (isViewer(ws)) {
        ws.data.authTimer = setTimeout(() => ws.close(4003, 'auth timeout'), AUTH_MS)
        return
      }
      if (!isBridge(ws)) return
      const { sid } = ws.data
      const s: Session = sessions.get(sid) ?? { tokens: new Map(), deltas: [], viewers: new Set() }
      sessions.set(sid, s)
      s.bridge?.close(4000, 'replaced')
      s.bridge = ws
      s.goneAt = undefined
    },
    message(ws, raw) {
      const text = String(raw)
      const m = parse(text)
      if (!m) return
      const s = sessions.get(ws.data.sid)
      if (isViewer(ws)) return onViewer(ws, s, m)
      // a replaced or ended bridge has no say
      if (isBridge(ws) && s?.bridge === ws) onBridge(ws, s, m as BridgeToRelay, text)
    },
    close(ws) {
      const s = sessions.get(ws.data.sid)
      if (isViewer(ws)) {
        clearTimeout(ws.data.authTimer)
        if (s?.viewers.delete(ws)) tellCounts(s)
        return
      }
      if (!isBridge(ws) || s?.bridge !== ws) return
      s.bridge = undefined
      s.goneAt = Date.now()
      for (const v of s.viewers) tell(v, { type: 'host', online: false })
    },
  },
})
console.log(`sshare relay on :${PORT}`)
