import { existsSync, rmSync } from 'node:fs'

import type { Control, Route } from '../types/protocol'
import { PANE, RELAY, SECRET_FILE, SID, SOCKET, emit, fail, readJson, send, state } from './core'
import { followPane } from './herdr'
import { addLink, allLinks, expireLinks, revoke } from './links'
import { connect } from './relay'

type Routes = { [Path in Route]: (request: Control[Path]['request']) => Control[Path]['response'] }

const PARENT_PID = process.ppid
const EXIT_GRACE_MS = 300
const EXPIRE_EVERY_MS = 10_000
const FOLLOW_EVERY_MS = 2000

const ROUTES = {
  '/link': addLink,
  '/links': () => ({ links: allLinks() }),
  '/revoke': ({ mode }) => ({ revoked: revoke((link) => mode === null || link.mode === mode) }),
  '/queued': (delivery) => {
    send({ type: 'queued', ...delivery })

    return { delivered: state.online }
  },
  '/stop': () => {
    stop()

    return { stopped: true }
  },
} satisfies Routes

function stop() {
  state.stopping = true
  send({ type: 'end' })
  state.observer?.kill()
  setTimeout(() => {
    rmSync(SOCKET, { force: true })
    process.exit(0)
  }, EXIT_GRACE_MS)
}

function watch() {
  if (process.ppid === PARENT_PID) {
    void followPane()
  } else {
    stop()
  }
}

function isRoute(path: string): path is Route {
  return Object.hasOwn(ROUTES, path)
}

async function answer(request: Request) {
  const path = new URL(request.url).pathname

  if (!isRoute(path)) {
    return new Response('not found', { status: 404 })
  }

  const body = readJson<Control[Route]['request']>(await request.text(), null)
  // SAFETY: ROUTES[path] is the handler for Control[path], whose request the mod just sent
  const handle = ROUTES[path] as (body: Control[Route]['request']) => Control[Route]['response']

  return Response.json(handle(body))
}

if (PANE === '') {
  fail('no herdr pane (is this session running inside herdr?)')
}

if (!existsSync(SECRET_FILE)) {
  fail(`no relay secret at ${SECRET_FILE}`)
}

rmSync(SOCKET, { force: true })
Bun.serve({ unix: SOCKET, fetch: answer })
setInterval(expireLinks, EXPIRE_EVERY_MS)
setInterval(watch, FOLLOW_EVERY_MS)
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
await followPane()
connect()
emit({ type: 'ready', sid: SID, socket: SOCKET, page: `${RELAY}/s/${SID}` })
