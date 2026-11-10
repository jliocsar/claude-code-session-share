import type { EngineInterface } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { Pending, ShareState } from '../types'
import type { Control, Delivery, Route } from '../types/protocol'
import { failureOf, statusText } from './text'

export type Verdict = 'approve' | 'reject'

const IDLE: ShareState = { socket: null, page: null, read: 0, edit: 0, relay: false }
const NONE: Pending[] = []
const MAX_PENDING = 20
const GUEST_HEADER = '[session-share guest via edit link]'

const share = atom({ plugin: 'session-share', key: 'share' } as const, IDLE, { shape: 'share-3' })
const pending = atom({ plugin: 'session-share', key: 'pending' } as const, NONE, {
  shape: 'pending-1',
})

export function showStatus($: EngineInterface, state: ShareState) {
  $.ui.status(state.socket === null ? undefined : statusText(state))
}

export function shareState($: EngineInterface) {
  return read($, share)
}

export function waitingGuests($: EngineInterface) {
  return read($, pending)
}

export function patchShare($: EngineInterface, patch: Partial<ShareState>) {
  return update($, share, (state) => ({ ...state, ...patch }))
}

export async function startShare($: EngineInterface, socket: string, page: string) {
  await update($, share, () => ({ ...IDLE, socket, page }))
}

export async function holdGuest($: EngineInterface, guest: Pending) {
  await update($, pending, (list) => [...list, guest].slice(-MAX_PENDING))
}

export async function resetState($: EngineInterface) {
  await update($, share, () => IDLE)
  await update($, pending, () => NONE)
}

export async function refreshStatus($: EngineInterface) {
  showStatus($, await read($, share))
}

export async function bridgeCall<Path extends Route>(
  $: EngineInterface,
  path: Path,
  request: Control[Path]['request'],
): Promise<Control[Path]['response']> {
  const { socket } = await read($, share)

  if (socket === null) {
    throw new Error('not sharing')
  }

  const response = await $.http.fetch(`http://bridge${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    socketPath: socket,
  })

  if (!response.ok) {
    throw new Error(`bridge said ${response.status}`)
  }

  // SAFETY: the bridge answers each Control route with that route's response
  return JSON.parse(response.text) as Control[Path]['response']
}

export async function isSharing($: EngineInterface) {
  return (await read($, share)).socket !== null
}

export async function ack($: EngineInterface, viewer: string, delivery: Delivery) {
  try {
    await bridgeCall($, '/queued', { viewer, ...delivery })
  } catch (cause) {
    $.ui.log(`session-share: couldn't tell the guest: ${failureOf(cause).message}`, {
      to: 'debug',
    })
  }
}

export async function queueGuest($: EngineInterface, text: string) {
  try {
    await $.prompt.submit({ text: `${GUEST_HEADER}\n${text}` })
  } catch (cause) {
    $.ui.toast(`session-share: guest message failed: ${failureOf(cause).message}`)
  }
}

export async function submitGuest($: EngineInterface, guest: Pending) {
  void queueGuest($, guest.text)
  await ack($, guest.viewer, { outcome: 'sent' })
}

export async function answerGuest($: EngineInterface, verdict: Verdict, guest: Pending) {
  if (verdict === 'approve') {
    await submitGuest($, guest)
  } else {
    await ack($, guest.viewer, { outcome: 'refused', why: 'the host declined it' })
  }
}

export async function settle($: EngineInterface, verdict: Verdict, all: boolean) {
  const waiting = await read($, pending)
  const picked = all ? waiting : waiting.slice(0, 1)
  const ids = new Set(picked.map(({ id }) => id))

  await update($, pending, (list) => list.filter(({ id }) => !ids.has(id)))
  await Promise.all(picked.map((guest) => answerGuest($, verdict, guest)))

  return picked.length
}
