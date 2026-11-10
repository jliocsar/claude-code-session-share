import { timingSafeEqual } from 'node:crypto'

import type { Server, ServerWebSocket } from 'bun'
import { safeParse } from 'valibot'

import type { BridgeToRelay, ViewerToRelay } from '../plugin/types/protocol'
import { BRIDGE_MESSAGE, SID, VIEWER_MESSAGE } from './schemas'
import type { BridgeData, BridgeSocket, Session, ViewerData, ViewerSocket } from './session'
import {
  admit,
  cacheFrame,
  holdsLiveToken,
  kick,
  refuse,
  relayPrompt,
  sessions,
  tell,
  tellAll,
  tellCounts,
} from './session'

export type SocketData = BridgeData | ViewerData

type AnySocket = ServerWebSocket<SocketData>

type Context<Peer> = { session: Session; socket: Peer; raw: string }

type Handlers<Message extends { type: string }, Peer> = {
  [Tag in Message['type']]: (
    message: Extract<Message, { type: Tag }>,
    context: Context<Peer>,
  ) => void
}

const SECRET = process.env.SESSION_SHARE_SECRET ?? ''

const BRIDGE_HANDLERS = {
  hello: ({ tokens }, { session }) => {
    session.tokens = new Map(tokens.map(({ hash, mode, expires }) => [hash, { mode, expires }]))
    kick(session, (viewer) => !holdsLiveToken(session, viewer), 'link revoked')
    tellAll(session, { type: 'host', online: true })
    tellCounts(session)
  },
  'token.add': ({ hash, mode, expires }, { session }) => {
    session.tokens.set(hash, { mode, expires })
  },
  'token.revoke': ({ hash }, { session }) => {
    session.tokens.delete(hash)
    kick(session, (viewer) => viewer.data.hash === hash, 'link revoked')
  },
  frame: ({ full }, { session, socket, raw }) => {
    cacheFrame(session, socket, full, raw)

    for (const viewer of session.viewers) {
      viewer.send(raw)
    }
  },
  queued: ({ viewer: id, ...delivery }, { session }) => {
    for (const viewer of session.viewers) {
      if (viewer.data.id === id) {
        tell(viewer, delivery)
      }
    }
  },
  end: (_message, { session, socket }) => {
    kick(session, () => true, 'the host stopped sharing')
    sessions.delete(socket.data.sid)
    socket.close(1000, 'ended')
  },
} satisfies Handlers<BridgeToRelay, BridgeSocket>

const VIEWER_HANDLERS = {
  auth: ({ token }, { session, socket }) => {
    if (socket.data.hash === null) {
      admit(socket, session, token)
    }
  },
  prompt: ({ text }, { session, socket }) => {
    if (socket.data.hash === null) {
      refuse(socket, 'auth first')

      return
    }

    relayPrompt(socket, session, socket.data.hash, text)
  },
} satisfies Handlers<ViewerToRelay, ViewerSocket>

function dispatch<Message extends { type: string }, Peer>(
  handlers: Handlers<Message, Peer>,
  message: Message,
  context: Context<Peer>,
) {
  // SAFETY: Handlers holds, under each tag, the handler for exactly that member of Message
  const handler = handlers[message.type as Message['type']] as (
    message: Message,
    context: Context<Peer>,
  ) => void

  handler(message, context)
}

export function isBridge(socket: AnySocket): socket is BridgeSocket {
  return socket.data.role === 'bridge'
}

export function isViewer(socket: AnySocket): socket is ViewerSocket {
  return socket.data.role === 'viewer'
}

function secretOk(header: string | null) {
  const got = Buffer.from(header?.replace(/^Bearer /u, '') ?? '')
  const want = Buffer.from(SECRET)

  return got.length === want.length && timingSafeEqual(got, want)
}

export function onBridgeMessage(bridge: BridgeSocket, raw: string) {
  const session = sessions.get(bridge.data.sid)
  const parsed = safeParse(BRIDGE_MESSAGE, raw)

  if (session?.bridge === bridge && parsed.success) {
    dispatch(BRIDGE_HANDLERS, parsed.output, { session, socket: bridge, raw })
  }
}

export function onViewerMessage(viewer: ViewerSocket, raw: string) {
  const session = sessions.get(viewer.data.sid)
  const parsed = safeParse(VIEWER_MESSAGE, raw)

  if (session === undefined) {
    refuse(viewer, 'this link is invalid or expired')

    return
  }

  if (parsed.success) {
    dispatch(VIEWER_HANDLERS, parsed.output, { session, socket: viewer, raw })
  }
}

export function upgradeBridge(request: Request, server: Server<SocketData>) {
  const sid = safeParse(SID, new URL(request.url).searchParams.get('sid'))

  if (!sid.success || !secretOk(request.headers.get('authorization'))) {
    return new Response('no', { status: 401 })
  }

  return server.upgrade(request, { data: { role: 'bridge', sid: sid.output } })
    ? undefined
    : new Response('upgrade failed', { status: 400 })
}

export function upgradeViewer(request: Request, server: Server<SocketData>) {
  const sid = safeParse(SID, new URL(request.url).searchParams.get('sid'))

  if (!sid.success) {
    return new Response('no', { status: 400 })
  }

  const data: ViewerData = {
    role: 'viewer',
    sid: sid.output,
    id: crypto.randomUUID(),
    hash: null,
    lastPrompt: 0,
    authTimer: null,
  }

  return server.upgrade(request, { data })
    ? undefined
    : new Response('upgrade failed', { status: 400 })
}
