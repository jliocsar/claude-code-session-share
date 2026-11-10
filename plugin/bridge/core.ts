import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'

import type { BridgeEvent, BridgeToRelay } from '../types/protocol'

type Size = { cols: number; rows: number }

type State = {
  socket: WebSocket | null
  online: boolean
  backoffMs: number
  observer: Bun.Subprocess<'ignore', 'pipe', 'ignore'> | null
  size: Size | null
  stopping: boolean
}

export const PANE = process.env.SESSION_SHARE_PANE ?? ''

export const RELAY = (process.env.SESSION_SHARE_RELAY ?? 'https://session-share.exe.xyz').replace(
  /\/$/u,
  '',
)
export const SECRET_FILE =
  process.env.SESSION_SHARE_SECRET_FILE ?? `${homedir()}/.config/session-share/secret`

export const SOCKET = `${process.env.XDG_RUNTIME_DIR ?? '/tmp'}/session-share-${process.pid}.sock`
export const SID = randomBytes(9).toString('base64url')
export const BACKOFF_MIN_MS = 500

export const state: State = {
  socket: null,
  online: false,
  backoffMs: BACKOFF_MIN_MS,
  observer: null,
  size: null,
  stopping: false,
}

export function emit(event: BridgeEvent) {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

export function fail(why: string): never {
  emit({ type: 'fatal', why })
  process.exit(1)
}

export function readJson<Value>(text: string, fallback: Value): Value {
  try {
    // SAFETY: every caller reads one of its own peers (the relay, herdr, the mod), which write Value
    return JSON.parse(text) as Value
  } catch {
    return fallback
  }
}

export function send(message: BridgeToRelay) {
  if (state.online) {
    state.socket?.send(JSON.stringify(message))
  }
}
