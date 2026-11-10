// End-to-end smoke test: a local relay, a real bridge on this herdr pane, fake viewers.
// Run inside herdr: `bun run test`. Needs `bun install` in relay/ (for ghostty-web).
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BridgeEvent, LinkView, RelayToViewer } from '../plugin/types/protocol'

const ROOT = new URL('..', import.meta.url).pathname
const PANE = process.env.HERDR_PANE_ID
if (!PANE) throw new Error('run this inside a herdr pane')

const secret = randomBytes(32).toString('hex')
const dir = mkdtempSync(join(tmpdir(), 'session-share-e2e-'))
writeFileSync(join(dir, 'secret'), secret, { mode: 0o600 })
const port = 20_000 + Math.floor(Math.random() * 20_000)
const relayUrl = `http://localhost:${port}`

const relay = Bun.spawn(['bun', join(ROOT, 'relay/server.ts')], {
  env: { ...process.env, SESSION_SHARE_SECRET: secret, PORT: String(port) },
  stdout: 'pipe',
  stderr: 'inherit',
})
const bridge = Bun.spawn(['bun', join(ROOT, 'plugin/bridge/bridge.ts')], {
  env: {
    ...process.env,
    SESSION_SHARE_PANE: PANE,
    SESSION_SHARE_RELAY: relayUrl,
    SESSION_SHARE_SECRET_FILE: join(dir, 'secret'),
  },
  stdout: 'pipe',
  stderr: 'inherit',
})

let failed = 0
function check(what: string, ok: unknown, detail?: unknown) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
}

async function waitFor<T>(get: () => T | undefined | false, ms = 10_000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = get()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await Bun.sleep(50)
  }
}

const events: BridgeEvent[] = []
void (async () => {
  const dec = new TextDecoder()
  let buf = ''
  for await (const chunk of bridge.stdout) {
    const parts = (buf + dec.decode(chunk, { stream: true })).split('\n')
    buf = parts.pop() ?? ''
    for (const line of parts) if (line) events.push(JSON.parse(line))
  }
})()
const last = <K extends BridgeEvent['type']>(type: K) =>
  events.findLast((e): e is Extract<BridgeEvent, { type: K }> => e.type === type)

function viewer(url: string, token?: string) {
  const u = new URL(url)
  const sid = u.pathname.split('/')[2]
  const ws = new WebSocket(`ws://${u.host}/ws/view?sid=${sid}`)
  const got: RelayToViewer[] = []
  const v = { ws, got, closed: undefined as { code: number; reason: string } | undefined }
  ws.onopen = () =>
    ws.send(JSON.stringify({ type: 'auth', token: token ?? new URLSearchParams(u.hash.slice(1)).get('t') }))
  ws.onmessage = e => got.push(JSON.parse(String(e.data)))
  ws.onclose = e => {
    v.closed = { code: e.code, reason: e.reason }
  }
  return v
}
const lastOf = <K extends RelayToViewer['type']>(v: { got: RelayToViewer[] }, type: K) =>
  v.got.findLast((m): m is Extract<RelayToViewer, { type: K }> => m.type === type)

try {
  await waitFor(() => last('ready'))
  await waitFor(() => last('relay')?.online)
  const sock = last('ready')?.socket
  const ctl = <T>(path: string, body = {}): Promise<T> =>
    fetch(`http://bridge${path}`, { method: 'POST', body: JSON.stringify(body), unix: sock }).then(r => r.json() as T)

  const read = await ctl<LinkView>('/link', { mode: 'read' })
  const approve = await ctl<LinkView>('/link', { mode: 'edit', ttlMs: 600_000 })
  const auto = await ctl<LinkView>('/link', { mode: 'edit', approve: false })
  check('edit links default to approve', approve.approve && !auto.approve, { approve, auto })
  check(
    'ttl is clamped to 7d',
    (await ctl<LinkView>('/link', { mode: 'read', ttlMs: 1e12 })).expires < Date.now() + 8 * 86_400_000,
  )

  const page = await fetch(read.url.replace(/#.*/, ''))
  check('viewer page served with a CSP', page.ok && page.headers.get('content-security-policy')?.includes("'self'"))
  check('home is a teapot', (await fetch(relayUrl)).status === 418)

  await Bun.sleep(1500) // let a frame reach the relay's cache
  const r = viewer(read.url)
  const a = viewer(approve.url)
  const w = viewer(auto.url)
  const bad = viewer(read.url, 'nope')
  const ghost = viewer(`${relayUrl}/s/notarealsid#t=x`)

  await waitFor(() => [r, a, w].every(v => lastOf(v, 'frame')))
  check('late joiners get a full frame', lastOf(r, 'frame') && r.got.find(m => m.type === 'frame' && m.full))
  check('hello carries the mode', lastOf(a, 'hello')?.mode === 'edit' && lastOf(r, 'hello')?.mode === 'read')
  await waitFor(() => bad.closed && ghost.closed)
  check('bad token closes 4003', bad.closed?.code === 4003, bad.closed)
  check('unknown session closes 4003', ghost.closed?.code === 4003, ghost.closed)

  await waitFor(() => last('viewers')?.read === 1 && last('viewers')?.edit === 2)
  check('viewer counts reach the mod', true)

  r.ws.send(JSON.stringify({ type: 'prompt', text: 'should be refused' }))
  const refused = await waitFor(() => lastOf(r, 'queued'))
  check('read link cannot prompt', !refused.ok && refused.why === 'read-only link', refused)

  a.ws.send(JSON.stringify({ type: 'prompt', text: 'from the approve link' }))
  const pa = await waitFor(() => last('prompt'))
  check('approve link prompt is held', pa.text === 'from the approve link' && pa.approve, pa)
  await ctl('/queued', { viewer: pa.viewer, ok: false, pending: true })
  check('guest sees pending', (await waitFor(() => lastOf(a, 'queued')))?.pending)

  w.ws.send(JSON.stringify({ type: 'prompt', text: 'from the auto link' }))
  const pw = await waitFor(() => events.findLast(e => e.type === 'prompt' && e.text === 'from the auto link'))
  check('auto link prompt is not held', pw.type === 'prompt' && !pw.approve, pw)

  w.ws.send(JSON.stringify({ type: 'prompt', text: 'too fast' }))
  await waitFor(() => lastOf(w, 'queued'))
  check('prompts are rate limited', lastOf(w, 'queued')?.why === 'slow down', lastOf(w, 'queued'))

  const countsBefore = events.filter(e => e.type === 'viewers').length
  await ctl('/revoke', { mode: 'read' })
  await waitFor(() => r.closed)
  check('revoke kicks read viewers', lastOf(r, 'closed')?.reason === 'link revoked', r.got.at(-1))
  await Bun.sleep(300)
  check('one counts update per kick', events.filter(e => e.type === 'viewers').length === countsBefore + 1)

  await ctl('/stop')
  await waitFor(() => a.closed && w.closed)
  check('stop kicks everyone', lastOf(a, 'closed')?.reason === 'the host stopped sharing', a.got.at(-1))
  check('bridge exits cleanly', (await bridge.exited) === 0)
} catch (err) {
  failed++
  console.log('FAIL', err)
} finally {
  bridge.kill()
  relay.kill()
}
console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
