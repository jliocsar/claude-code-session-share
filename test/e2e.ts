import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  BridgeEvent,
  Control,
  RelayToViewer,
  Route,
  ViewerToRelay,
} from '../plugin/types/protocol'

type Closed = { code: number; reason: string }

type Viewer = { socket: WebSocket; got: RelayToViewer[]; closed: Closed | null }

type Of<Union extends { type: string }, Tag extends Union['type']> = Extract<Union, { type: Tag }>

const ROOT = new URL('..', import.meta.url).pathname
const PANE = process.env.HERDR_PANE_ID ?? ''
const SECRET = randomBytes(32).toString('hex')
const DIR = mkdtempSync(join(tmpdir(), 'session-share-e2e-'))
const PORT = 20_000 + Math.floor(Math.random() * 20_000)
const RELAY_URL = `http://localhost:${PORT}`
const WAIT_MS = 10_000
const POLL_MS = 50
const FRAME_SETTLE_MS = 1500
const KICK_SETTLE_MS = 300

const events: BridgeEvent[] = []
const results = { failed: 0 }

function check(what: string, ok: boolean) {
  results.failed += ok ? 0 : 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
}

async function waitFor<Value>(get: () => Value | undefined) {
  const deadline = Date.now() + WAIT_MS

  while (Date.now() < deadline) {
    const value = get()

    if (value !== undefined) {
      return value
    }

    await Bun.sleep(POLL_MS)
  }

  throw new Error('timed out')
}

async function waitUntil(condition: () => boolean) {
  await waitFor(() => (condition() ? true : undefined))
}

function lastEvent<Tag extends BridgeEvent['type']>(type: Tag) {
  return events.findLast((event): event is Of<BridgeEvent, Tag> => event.type === type)
}

function lastOf<Tag extends RelayToViewer['type']>(viewer: Viewer, type: Tag) {
  return viewer.got.findLast((message): message is Of<RelayToViewer, Tag> => message.type === type)
}

function countOf(type: BridgeEvent['type']) {
  return events.filter((event) => event.type === type).length
}

function send(viewer: Viewer, message: ViewerToRelay) {
  viewer.socket.send(JSON.stringify(message))
}

function watch(url: string, token: string | null) {
  const link = new URL(url)
  const sid = link.pathname.split('/')[2] ?? ''
  const socket = new WebSocket(`ws://${link.host}/ws/view?sid=${sid}`)
  const viewer: Viewer = { socket, got: [], closed: null }
  const linkToken = new URLSearchParams(link.hash.slice(1)).get('t') ?? ''

  socket.addEventListener('open', () => {
    send(viewer, { type: 'auth', token: token ?? linkToken })
  })
  socket.addEventListener('message', ({ data }: MessageEvent<string>) => {
    // SAFETY: the relay under test writes RelayToViewer messages
    viewer.got.push(JSON.parse(data) as RelayToViewer)
  })
  socket.addEventListener('close', ({ code, reason }) => {
    viewer.closed = { code, reason }
  })

  return viewer
}

async function readEvents(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  let buffered = ''

  for await (const chunk of stream) {
    const parts = (buffered + decoder.decode(chunk, { stream: true })).split('\n')

    buffered = parts.pop() ?? ''

    for (const line of parts.filter((part) => part !== '')) {
      // SAFETY: the bridge writes one BridgeEvent per stdout line
      events.push(JSON.parse(line) as BridgeEvent)
    }
  }
}

async function control<Path extends Route>(
  socket: string,
  path: Path,
  body: Control[Path]['request'],
): Promise<Control[Path]['response']> {
  const response = await fetch(`http://bridge${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    unix: socket,
  })

  // SAFETY: the bridge answers each Control route with that route's response
  return (await response.json()) as Control[Path]['response']
}

async function checkLinksAndPages(socket: string) {
  const approve = await control(socket, '/link', { mode: 'edit', ttlMs: 600_000, approve: true })
  const auto = await control(socket, '/link', { mode: 'edit', ttlMs: null, approve: false })
  const forever = await control(socket, '/link', { mode: 'read', ttlMs: 1e12, approve: true })
  const read = await control(socket, '/link', { mode: 'read', ttlMs: null, approve: true })
  const page = await fetch(read.url.replace(/#.*/u, ''))
  const script = await fetch(`${RELAY_URL}/viewer.js`)
  const policy = page.headers.get('content-security-policy') ?? ''

  check('edit links keep their approval mode', approve.approve && !auto.approve)
  check('ttl is clamped to 7d', forever.expires < Date.now() + 8 * 86_400_000)
  check('viewer page served with a CSP', page.ok && policy.includes("'self'"))
  check('viewer script is built and served', script.ok && (await script.text()).length > 0)
  check('home is a teapot', (await fetch(RELAY_URL)).status === 418)

  return { read, approve, auto }
}

async function checkJoining(urls: { read: string; approve: string; auto: string }) {
  await Bun.sleep(FRAME_SETTLE_MS)

  const reader = watch(urls.read, null)
  const approver = watch(urls.approve, null)
  const autoViewer = watch(urls.auto, null)
  const bad = watch(urls.read, 'nope')
  const ghost = watch(`${RELAY_URL}/s/notarealsid#t=x`, null)

  await waitUntil(() =>
    [reader, approver, autoViewer].every((viewer) => lastOf(viewer, 'frame') !== undefined),
  )
  check(
    'late joiners get a full frame',
    reader.got.some((message) => message.type === 'frame' && message.full),
  )
  check(
    'hello carries the mode',
    lastOf(approver, 'hello')?.mode === 'edit' && lastOf(reader, 'hello')?.mode === 'read',
  )
  await waitUntil(() => bad.closed !== null && ghost.closed !== null)
  check('bad token closes 4003', bad.closed?.code === 4003)
  check('unknown session closes 4003', ghost.closed?.code === 4003)
  await waitUntil(() => lastEvent('viewers')?.read === 1 && lastEvent('viewers')?.edit === 2)
  check('viewer counts reach the mod', true)

  return { reader, approver, autoViewer }
}

async function checkPrompts(socket: string, reader: Viewer, approver: Viewer, autoViewer: Viewer) {
  send(reader, { type: 'prompt', text: 'should be refused' })

  const refused = await waitFor(() => lastOf(reader, 'queued'))

  check(
    'read link cannot prompt',
    refused.outcome === 'refused' && refused.why === 'read-only link',
  )
  send(approver, { type: 'prompt', text: 'from the approve link' })

  const held = await waitFor(() => lastEvent('prompt'))

  check('approve link prompt is held', held.text === 'from the approve link' && held.approve)
  await control(socket, '/queued', { viewer: held.viewer, outcome: 'pending' })
  check(
    'guest sees pending',
    (await waitFor(() => lastOf(approver, 'queued'))).outcome === 'pending',
  )
  send(autoViewer, { type: 'prompt', text: 'from the auto link' })

  const free = await waitFor(() =>
    events.find((event) => event.type === 'prompt' && event.text === 'from the auto link'),
  )

  check('auto link prompt is not held', free.type === 'prompt' && !free.approve)
  send(autoViewer, { type: 'prompt', text: 'too fast' })

  const limited = await waitFor(() => lastOf(autoViewer, 'queued'))

  check('prompts are rate limited', limited.outcome === 'refused' && limited.why === 'slow down')
}

async function checkRevokeAndStop(
  socket: string,
  viewers: Record<'reader' | 'approver' | 'autoViewer', Viewer>,
) {
  const { reader, approver, autoViewer } = viewers
  const countsBefore = countOf('viewers')

  await control(socket, '/revoke', { mode: 'read' })
  await waitUntil(() => reader.closed !== null)
  check('revoke kicks read viewers', lastOf(reader, 'closed')?.reason === 'link revoked')
  await Bun.sleep(KICK_SETTLE_MS)
  check('one counts update per kick', countOf('viewers') === countsBefore + 1)
  await control(socket, '/stop', null)
  await waitUntil(() => approver.closed !== null && autoViewer.closed !== null)
  check('stop kicks everyone', lastOf(approver, 'closed')?.reason === 'the host stopped sharing')
}

async function scenario(socket: string) {
  const links = await checkLinksAndPages(socket)
  const viewers = await checkJoining({
    read: links.read.url,
    approve: links.approve.url,
    auto: links.auto.url,
  })

  await checkPrompts(socket, viewers.reader, viewers.approver, viewers.autoViewer)
  await checkRevokeAndStop(socket, viewers)
}

function spawnRelay() {
  return Bun.spawn(['bun', join(ROOT, 'relay/server.ts')], {
    env: { ...process.env, SESSION_SHARE_SECRET: SECRET, PORT: `${PORT}` },
    stdout: 'pipe',
    stderr: 'inherit',
  })
}

function spawnBridge() {
  return Bun.spawn(['bun', join(ROOT, 'plugin/bridge/bridge.ts')], {
    env: {
      ...process.env,
      SESSION_SHARE_PANE: PANE,
      SESSION_SHARE_RELAY: RELAY_URL,
      SESSION_SHARE_SECRET_FILE: join(DIR, 'secret'),
    },
    stdout: 'pipe',
    stderr: 'inherit',
  })
}

async function main() {
  const relay = spawnRelay()
  const bridge = spawnBridge()

  void readEvents(bridge.stdout)

  try {
    const ready = await waitFor(() => lastEvent('ready'))

    await waitUntil(() => lastEvent('relay')?.online === true)
    await scenario(ready.socket)
    check('bridge exits cleanly', (await bridge.exited) === 0)
  } catch (cause) {
    check(`no errors (${cause instanceof Error ? cause.message : 'unknown'})`, false)
  } finally {
    bridge.kill()
    relay.kill()
  }
}

if (PANE === '') {
  throw new Error('run this inside a herdr pane')
}

writeFileSync(join(DIR, 'secret'), SECRET, { mode: 0o600 })
await main()
console.log(results.failed > 0 ? `${results.failed} failed` : 'all passed')
process.exit(results.failed > 0 ? 1 : 0)
