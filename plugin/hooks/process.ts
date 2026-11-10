import type { EngineInterface } from 'claude-code'

import type { Pending } from '../types'
import type { BridgeEvent } from '../types/protocol'
import {
  ack,
  holdGuest,
  patchShare,
  resetState,
  shareState,
  showStatus,
  startShare,
  submitGuest,
} from './control'
import { failureOf } from './text'

type Starter = { ready: boolean; resolve: (socket: string) => void; reject: (error: Error) => void }

type EventOf<Tag extends BridgeEvent['type']> = Extract<BridgeEvent, { type: Tag }>

async function onReady($: EngineInterface, event: EventOf<'ready'>, starter: Starter) {
  await startShare($, event.socket, event.page)
  starter.ready = true
  starter.resolve(event.socket)
}

async function onRelay($: EngineInterface, event: EventOf<'relay'>) {
  showStatus($, await patchShare($, { relay: event.online }))
}

async function onViewers($: EngineInterface, event: EventOf<'viewers'>) {
  const before = await shareState($)
  const after = await patchShare($, { read: event.read, edit: event.edit })

  if (after.read + after.edit > before.read + before.edit) {
    $.ui.toast('session-share: someone joined')
  }

  showStatus($, after)
}

async function onPrompt($: EngineInterface, event: EventOf<'prompt'>) {
  const guest: Pending = { id: crypto.randomUUID(), text: event.text, viewer: event.viewer }

  if (!event.approve) {
    await submitGuest($, guest)
    $.ui.toast('session-share: guest message queued')

    return
  }

  await holdGuest($, guest)
  await ack($, guest.viewer, { outcome: 'pending' })
  $.ui.toast('session-share: guest message waiting for your ok')
}

function onFatal($: EngineInterface, event: EventOf<'fatal'>, starter: Starter) {
  if (starter.ready) {
    $.ui.toast(`session-share: ${event.why}`)
  } else {
    starter.reject(new Error(event.why))
  }
}

async function onEvent($: EngineInterface, event: BridgeEvent, starter: Starter) {
  if (event.type === 'ready') {
    await onReady($, event, starter)
  }

  if (event.type === 'relay') {
    await onRelay($, event)
  }

  if (event.type === 'viewers') {
    await onViewers($, event)
  }

  if (event.type === 'prompt') {
    await onPrompt($, event)
  }

  if (event.type === 'fatal') {
    onFatal($, event, starter)
  }
}

async function onBridgeLine($: EngineInterface, line: string, starter: Starter) {
  if (line !== '') {
    // SAFETY: the bridge writes one BridgeEvent per stdout line
    await onEvent($, JSON.parse(line) as BridgeEvent, starter)
  }
}

async function bridgeEnv($: EngineInterface): Promise<Record<string, string>> {
  const pane = (await $.env.get('HERDR_PANE_ID')) ?? ''
  const relay = (await $.env.get('SESSION_SHARE_RELAY')) ?? ''

  if (pane === '') {
    throw new Error('this session is not inside a herdr pane, so there is no terminal to share')
  }

  return relay === ''
    ? { SESSION_SHARE_PANE: pane }
    : { SESSION_SHARE_PANE: pane, SESSION_SHARE_RELAY: relay }
}

async function pumpBridge($: EngineInterface, starter: Starter) {
  const env = await bridgeEnv($)
  const child = $.process.spawn({ argv: ['bun', `${$.plugin.root}/bridge/bridge.ts`], env })
  let buffered = ''

  for await (const { stream, text } of child) {
    if (stream === 'stderr') {
      $.ui.log(text, { to: 'debug' })
    } else {
      const lines = (buffered + text).split('\n')

      buffered = lines.pop() ?? ''

      for (const line of lines) {
        await onBridgeLine($, line, starter)
      }
    }
  }
}

async function runBridge($: EngineInterface, starter: Starter) {
  try {
    await pumpBridge($, starter)
  } catch (cause) {
    starter.reject(failureOf(cause))
  } finally {
    starting = null
    await resetState($)
    $.ui.status(undefined)
    starter.reject(new Error('the bridge exited before it was ready (is bun on PATH?)'))
  }
}

export function ensureBridge($: EngineInterface) {
  starting ??= new Promise<string>((resolve, reject) => {
    void runBridge($, { ready: false, resolve, reject })
  })

  return starting
}

let starting: Promise<string> | null = null
