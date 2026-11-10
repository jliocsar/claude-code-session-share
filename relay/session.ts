import { createHash } from 'node:crypto'

import type { ServerWebSocket } from 'bun'

import type { Mode, RelayToBridge, RelayToViewer } from '../plugin/types/protocol'

type Token = { mode: Mode; expires: number }

export type BridgeData = { role: 'bridge'; sid: string }

export type ViewerData = {
  role: 'viewer'
  sid: string
  id: string
  hash: string | null
  lastPrompt: number
  authTimer: Timer | null
}

export type BridgeSocket = ServerWebSocket<BridgeData>

export type ViewerSocket = ServerWebSocket<ViewerData>

export type Session = {
  bridge: BridgeSocket | null
  tokens: Map<string, Token>
  full: string | null
  deltas: string[]
  viewers: Set<ViewerSocket>
  goneAt: number | null
}

const HOST_GRACE_MS = 10 * 60_000
const AUTH_MS = 5000
const MAX_DELTAS = 300
const MAX_PROMPT = 8000
const PROMPT_GAP_MS = 1500

export const sessions = new Map<string, Session>()

function sha(text: string) {
  return createHash('sha256').update(text).digest('hex')
}

export function tell(viewer: ViewerSocket, message: RelayToViewer) {
  viewer.send(JSON.stringify(message))
}

export function tellAll(session: Session, message: RelayToViewer) {
  for (const viewer of session.viewers) {
    tell(viewer, message)
  }
}

export function tellBridge(bridge: BridgeSocket, message: RelayToBridge) {
  bridge.send(JSON.stringify(message))
}

export function liveToken(session: Session, hash: string) {
  const token = session.tokens.get(hash)

  return token !== undefined && token.expires >= Date.now() ? token : null
}

export function holdsLiveToken(session: Session, viewer: ViewerSocket) {
  return viewer.data.hash === null || liveToken(session, viewer.data.hash) !== null
}

export function tellCounts(session: Session) {
  if (session.bridge === null) {
    return
  }

  const edit = [...session.viewers].filter(
    (viewer) => viewer.data.hash !== null && session.tokens.get(viewer.data.hash)?.mode === 'edit',
  ).length

  tellBridge(session.bridge, { type: 'viewers', read: session.viewers.size - edit, edit })
}

export function kick(session: Session, matches: (viewer: ViewerSocket) => boolean, reason: string) {
  const kicked = [...session.viewers].filter(matches)

  for (const viewer of kicked) {
    tell(viewer, { type: 'closed', reason })
    session.viewers.delete(viewer)
    viewer.close(4001, reason)
  }

  if (kicked.length > 0) {
    tellCounts(session)
  }
}

export function refuse(viewer: ViewerSocket, reason: string) {
  tell(viewer, { type: 'closed', reason })
  viewer.close(4003, reason)
}

export function cacheFrame(session: Session, bridge: BridgeSocket, full: boolean, raw: string) {
  if (full) {
    session.full = raw
    session.deltas = []

    return
  }

  if (session.full === null) {
    return
  }

  session.deltas.push(raw)

  if (session.deltas.length > MAX_DELTAS) {
    tellBridge(bridge, { type: 'resync' })
  }
}

export function admit(viewer: ViewerSocket, session: Session, token: string) {
  const hash = sha(token)
  const granted = liveToken(session, hash)

  if (granted === null) {
    refuse(viewer, 'this link is invalid or expired')

    return
  }

  clearTimer(viewer)
  viewer.data.hash = hash
  session.viewers.add(viewer)
  tell(viewer, { type: 'hello', ...granted, online: session.bridge !== null })

  if (session.full !== null) {
    for (const frame of [session.full, ...session.deltas]) {
      viewer.send(frame)
    }
  }

  tellCounts(session)
}

export function relayPrompt(viewer: ViewerSocket, session: Session, hash: string, text: string) {
  const token = liveToken(session, hash)

  if (token === null) {
    kick(session, (other) => other === viewer, 'this link expired')

    return
  }

  const why = promptRefusal(viewer, session, token, text)

  if (why !== null) {
    tell(viewer, { type: 'queued', outcome: 'refused', why })

    return
  }

  if (session.bridge !== null && text !== '') {
    viewer.data.lastPrompt = Date.now()
    tellBridge(session.bridge, { type: 'prompt', text, viewer: viewer.data.id, hash })
  }
}

function promptRefusal(viewer: ViewerSocket, session: Session, token: Token, text: string) {
  if (token.mode !== 'edit') {
    return 'read-only link'
  }

  if (text === '') {
    return null
  }

  if (text.length > MAX_PROMPT) {
    return `too long (max ${MAX_PROMPT})`
  }

  if (Date.now() - viewer.data.lastPrompt < PROMPT_GAP_MS) {
    return 'slow down'
  }

  return session.bridge === null ? 'host is offline' : null
}

export function clearTimer(viewer: ViewerSocket) {
  if (viewer.data.authTimer !== null) {
    clearTimeout(viewer.data.authTimer)
    viewer.data.authTimer = null
  }
}

export function sweep() {
  const now = Date.now()

  for (const [sid, session] of sessions) {
    kick(session, (viewer) => !holdsLiveToken(session, viewer), 'this link expired')

    for (const [hash, token] of session.tokens) {
      if (token.expires < now) {
        session.tokens.delete(hash)
      }
    }

    if (
      session.bridge === null &&
      session.goneAt !== null &&
      now - session.goneAt > HOST_GRACE_MS
    ) {
      kick(session, () => true, 'the host went away')
      sessions.delete(sid)
    }
  }
}

export function startAuthTimer(viewer: ViewerSocket) {
  viewer.data.authTimer = setTimeout(() => {
    viewer.close(4003, 'auth timeout')
  }, AUTH_MS)
}

export function closeViewer(viewer: ViewerSocket) {
  const session = sessions.get(viewer.data.sid)

  clearTimer(viewer)

  if (session?.viewers.delete(viewer) === true) {
    tellCounts(session)
  }
}

export function openBridge(bridge: BridgeSocket) {
  const session = sessions.get(bridge.data.sid) ?? {
    bridge: null,
    tokens: new Map<string, Token>(),
    full: null,
    deltas: [],
    viewers: new Set<ViewerSocket>(),
    goneAt: null,
  }

  sessions.set(bridge.data.sid, session)
  session.bridge?.close(4000, 'replaced')
  session.bridge = bridge
  session.goneAt = null
}

export function closeBridge(bridge: BridgeSocket) {
  const session = sessions.get(bridge.data.sid)

  if (session?.bridge !== bridge) {
    return
  }

  session.bridge = null
  session.goneAt = Date.now()
  tellAll(session, { type: 'host', online: false })
}
