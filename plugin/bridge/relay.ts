import { readFileSync } from 'node:fs'

import type { RelayToBridge } from '../types/protocol'
import { BACKOFF_MIN_MS, RELAY, SECRET_FILE, SID, emit, readJson, send, state } from './core'
import { restartObserve } from './herdr'
import { approves, tokenInfos } from './links'

type Handlers<Message extends { type: string }> = {
  [Tag in Message['type']]: (message: Extract<Message, { type: Tag }>) => void
}

const BACKOFF_MAX_MS = 15_000

const HANDLERS = {
  prompt: ({ text, viewer, hash }) => {
    emit({ type: 'prompt', text, viewer, approve: approves(hash) })
  },
  viewers: ({ read, edit }) => {
    emit({ type: 'viewers', read, edit })
  },
  resync: restartObserve,
} satisfies Handlers<RelayToBridge>

function dispatch<Message extends { type: string }>(handlers: Handlers<Message>, message: Message) {
  // SAFETY: Handlers holds, under each tag, the handler for exactly that member of Message
  const handler = handlers[message.type as Message['type']] as (message: Message) => void

  handler(message)
}

export function connect() {
  const socket = new WebSocket(`${RELAY.replace(/^http/u, 'ws')}/ws/bridge?sid=${SID}`, {
    headers: { authorization: `Bearer ${readFileSync(SECRET_FILE, 'utf8').trim()}` },
  })

  state.socket = socket
  socket.addEventListener('open', onRelayOpen)
  socket.addEventListener('close', onRelayClose)
  socket.addEventListener('message', ({ data }: MessageEvent<string>) => {
    const message = readJson<RelayToBridge | null>(data, null)

    if (message !== null) {
      dispatch(HANDLERS, message)
    }
  })
}

function onRelayOpen() {
  state.online = true
  state.backoffMs = BACKOFF_MIN_MS
  send({ type: 'hello', tokens: tokenInfos() })
  restartObserve()
  emit({ type: 'relay', online: true })
}

function onRelayClose() {
  if (state.online) {
    emit({ type: 'relay', online: false })
  }

  state.online = false

  if (!state.stopping) {
    setTimeout(connect, state.backoffMs)
    state.backoffMs = Math.min(state.backoffMs * 2, BACKOFF_MAX_MS)
  }
}
