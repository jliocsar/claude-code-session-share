import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { Pending, ShareState } from '../types'
import type { BridgeEvent, LinkView } from '../types/protocol'

const IDLE: ShareState = { read: 0, edit: 0, relay: false }
const share = atom({ plugin: 'sshare', key: 'share' } as const, IDLE, { shape: 'share-2' })
const pending = atom({ plugin: 'sshare', key: 'pending' } as const, [] as Pending[], { shape: 'pending-1' })

const MAX_PENDING = 20
const GUEST_HEADER = '[sshare guest via edit link]'
const USAGE = [
  'usage:',
  '  /sshare read [ttl]                       watch-only link (ttl like 30m, 2h, 1d; default 2h)',
  '  /sshare edit [ttl] [--mode approve|auto] link that can send prompts; approve (default) holds each one for your ok',
  '  /sshare approve [all] | reject [all]     answer held guest messages (or press y/n on the band after ctrl+x tab)',
  '  /sshare list                             active links',
  '  /sshare revoke [read|edit]               kill links, keep sharing',
  '  /sshare stop                             stop sharing, kick everyone',
].join('\n')

// The module's handle on the bridge. A reload starts it over and kills the old child.
let starting: Promise<string> | undefined

// ---- parsing

// `30m`, `2h`, `1d`. The bridge clamps the result to 1m..7d.
function parseTtl(s: string | undefined) {
  if (!s) return undefined
  const m = s.match(/^(\d+)([mhd])$/)
  if (!m) return null
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd']
}

// `edit 30m --mode auto`, `edit --mode=approve 2h`, `edit`
function parseArgs(args: string) {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const sub = words.shift() ?? ''
  let mode: string | undefined
  const rest: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? ''
    if (w === '--mode') mode = words[++i]
    else if (w.startsWith('--mode=')) mode = w.slice('--mode='.length)
    else rest.push(w)
  }
  return { sub, mode, rest }
}

function parseEvent(line: string): BridgeEvent | undefined {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

// Anything printed here is streamed to every viewer, so a link's token never goes on screen.
const bare = (url: string) => url.replace(/#.*/, '')

const until = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const linkKind = (l: LinkView) => (l.mode === 'read' ? 'read' : `edit/${l.approve ? 'approve' : 'auto'}`)

// ---- status line

function statusText(s: ShareState) {
  const dot = s.relay ? '●' : '○'
  const watching = s.read + s.edit
  if (!watching) return `${dot} sshare`
  const senders = s.edit ? ` (${s.edit} can send)` : ''
  return `${dot} sshare · ${watching} watching${senders}`
}

function showStatus($: EngineInterface, s: ShareState) {
  return $.ui.status(s.socket ? statusText(s) : undefined)
}

// ---- bridge control socket

async function bridgeCall<T>($: EngineInterface, path: string, body?: unknown): Promise<T> {
  const s = await read($, share)
  if (!s.socket) throw new Error('not sharing')
  const r = await $.http.fetch(`http://bridge${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    socketPath: s.socket,
  })
  if (!r.ok) throw new Error(`bridge said ${r.status}`)
  return JSON.parse(r.text)
}

// Tell the guest's page what happened to its message. Best effort.
async function ack($: EngineInterface, viewer: string, result: { ok: boolean; pending?: boolean; why?: string }) {
  await bridgeCall($, '/queued', { viewer, ...result }).catch(() => {})
}

// ---- guest messages

async function submitGuest($: EngineInterface, p: Pending) {
  // not awaited: submit settles when the turn runs, and the guest only needs to know it's queued
  $.prompt
    .submit({ text: `${GUEST_HEADER}\n${p.text}` })
    .catch(err => $.ui.toast(`sshare: guest message failed: ${err}`))
  await ack($, p.viewer, { ok: true })
}

type Verdict = 'approve' | 'reject'

async function settle($: EngineInterface, verdict: Verdict, all = false) {
  const list = await read($, pending)
  const picked = all ? list : list.slice(0, 1)
  if (!picked.length) return 0
  const done = new Set(picked.map(p => p.id))
  await update($, pending, l => l.filter(p => !done.has(p.id)))
  for (const p of picked) {
    if (verdict === 'approve') await submitGuest($, p)
    else await ack($, p.viewer, { ok: false, why: 'the host declined it' })
  }
  return picked.length
}

async function onGuestPrompt($: EngineInterface, text: string, viewer: string, approve: boolean) {
  const p: Pending = { id: crypto.randomUUID(), text, viewer }
  if (!approve) {
    await submitGuest($, p)
    await $.ui.toast('sshare: guest message queued')
    return
  }
  await update($, pending, l => [...l, p].slice(-MAX_PENDING))
  await ack($, viewer, { ok: false, pending: true })
  await $.ui.toast('sshare: guest message waiting for your ok')
}

// ---- bridge process

async function onBridgeEvent($: EngineInterface, ev: BridgeEvent) {
  switch (ev.type) {
    case 'relay':
      await showStatus($, await update($, share, s => ({ ...s, relay: ev.online })))
      return
    case 'viewers': {
      const before = await read($, share)
      const after = await update($, share, s => ({ ...s, read: ev.read, edit: ev.edit }))
      if (after.read + after.edit > before.read + before.edit) await $.ui.toast('sshare: someone joined')
      await showStatus($, after)
      return
    }
    case 'prompt':
      return onGuestPrompt($, ev.text, ev.viewer, ev.approve)
    case 'fatal':
      await $.ui.toast(`sshare: ${ev.why}`)
      return
  }
}

async function runBridge($: EngineInterface, resolve: (socket: string) => void, reject: (e: Error) => void) {
  const pane = await $.env.get('HERDR_PANE_ID')
  if (!pane) return reject(new Error('this session is not inside a herdr pane, so there is no terminal to share'))
  const relay = await $.env.get('SSHARE_RELAY')
  const env: Record<string, string> = { SSHARE_PANE: pane }
  if (relay) env.SSHARE_RELAY = relay
  const child = $.process.spawn({ argv: ['bun', `${$.plugin.root}/bridge/bridge.ts`], env })
  let ready = false
  let buf = ''
  try {
    for await (const piece of child) {
      if (!('stream' in piece)) continue
      if (piece.stream === 'stderr') {
        await $.ui.log(piece.text, { to: 'debug' })
        continue
      }
      const lines = (buf + piece.text).split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const ev = parseEvent(line)
        if (ev?.type === 'ready') {
          ready = true
          await update($, share, () => ({ ...IDLE, socket: ev.socket, sid: ev.sid, page: ev.page }))
          resolve(ev.socket)
        } else if (ev?.type === 'fatal' && !ready) reject(new Error(ev.why))
        else if (ev) await onBridgeEvent($, ev)
      }
    }
  } catch (err) {
    if (!ready) reject(err instanceof Error ? err : new Error(String(err)))
  } finally {
    starting = undefined
    await update($, share, () => IDLE)
    await update($, pending, () => [])
    await $.ui.status(undefined)
    // a no-op if it already resolved or rejected
    reject(new Error('the bridge exited before it was ready (is bun on PATH?)'))
  }
}

function ensureBridge($: EngineInterface): Promise<string> {
  if (starting) return starting
  const p = new Promise<string>((resolve, reject) => void runBridge($, resolve, reject))
  starting = p
  p.catch(() => {
    if (starting === p) starting = undefined
  })
  return p
}

// ---- /sshare

async function shareLink(
  $: EngineInterface,
  sub: 'read' | 'edit',
  mode: string | undefined,
  ttlArg: string | undefined,
) {
  const ttlMs = parseTtl(ttlArg)
  if (ttlMs === null) return `bad ttl "${ttlArg}"\n${USAGE}`
  if (mode !== undefined && mode !== 'approve' && mode !== 'auto')
    return `bad --mode "${mode}" (approve or auto)\n${USAGE}`
  if (sub === 'read' && mode) return '--mode only applies to edit links.'
  await ensureBridge($)
  const l = await bridgeCall<LinkView>($, '/link', { mode: sub, ttlMs, approve: mode !== 'auto' })
  await showStatus($, await read($, share))
  const copied = (await $.ui.copy({ text: l.url })).isCopied
  const head = copied
    ? `${linkKind(l)} link copied to your clipboard (until ${until(l.expires)}). its token stays off screen:\n${bare(l.url)}`
    : `${linkKind(l)} link (until ${until(l.expires)}). couldn't copy it, so here it is whole. anyone watching can see it:\n${l.url}`
  if (l.mode === 'read') return head
  if (l.approve)
    return `${head}\nguest messages wait for your ok: y/n on the band (ctrl+x tab) or /sshare approve|reject.`
  return `${head}\nauto mode: anyone with this link can prompt this session (and its tools) without asking. share it carefully.`
}

async function listLinks($: EngineInterface) {
  const { links } = await bridgeCall<{ links: LinkView[] }>($, '/links')
  if (!links.length) return 'sharing, but no active links.'
  return links.map(l => `${linkKind(l).padEnd(13)}  until ${until(l.expires)}  ${bare(l.url)}`).join('\n')
}

async function runCommand($: EngineInterface, args: string) {
  const { sub, mode, rest } = parseArgs(args)
  const sharing = !!(await read($, share)).socket
  switch (sub) {
    case 'read':
    case 'edit':
      return shareLink($, sub, mode, rest[0])
    case 'approve':
    case 'reject': {
      const n = await settle($, sub, rest[0] === 'all')
      return n ? `${sub === 'approve' ? 'approved' : 'rejected'} ${n} guest message(s).` : 'nothing waiting.'
    }
    case 'list':
      return sharing ? listLinks($) : 'not sharing.'
    case 'revoke': {
      const m = rest[0] === 'read' || rest[0] === 'edit' ? rest[0] : undefined
      const { revoked } = await bridgeCall<{ revoked: number }>($, '/revoke', { mode: m })
      return `revoked ${revoked} link(s).`
    }
    case 'stop':
      if (!sharing) return 'not sharing.'
      await settle($, 'reject', true)
      await bridgeCall($, '/stop').catch(() => {})
      return 'stopped sharing. every viewer got kicked.'
    default:
      return USAGE
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sshare',
      description: 'Share this session as a live web link (read or edit)',
      argumentHint: 'read|edit [ttl] [--mode approve|auto] | approve|reject [all] | list | revoke | stop',
      immediate: true,
    })
    await update($, share, () => IDLE)
    await update($, pending, () => [])
    return next(e)
  })

  on('command.run', { command: 'sshare' }, async ($, e) => {
    try {
      return { text: await runCommand($, e.args) }
    } catch (err) {
      return { text: `sshare: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, pending)
    const first = list[0]
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    if (!first) {
      const s = await read($, share)
      if (!s.socket) return next(e)
      const below = await next(e)
      return (
        <Box flexDirection="column">
          {below}
          <Text dimColor>
            {statusText(s).replace('sshare', 'sharing session')}
            {s.page ? ` · ${s.page.replace(/^https?:\/\//, '')}` : ''}
          </Text>
        </Box>
      )
    }
    const oneLine = first.text.replace(/\s+/g, ' ')
    const preview = oneLine.length > 160 ? `${oneLine.slice(0, 157)}…` : oneLine
    const more = list.length > 1
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text>
          <Text color="yellow" bold>
            sshare guest wants to send
          </Text>
          {more ? <Text dimColor> (+{list.length - 1} more)</Text> : null}
        </Text>
        <Text>{preview}</Text>
        <Box gap={2}>
          <Button key="approve" hotkey="y" label="approve" variant="primary" onPress={() => settle($, 'approve')} />
          <Button key="reject" hotkey="n" label="reject" onPress={() => settle($, 'reject')} />
          {more ? (
            <Button key="approve-all" hotkey="a" label="approve all" onPress={() => settle($, 'approve', true)} />
          ) : null}
          <Text dimColor>ctrl+x tab to focus · /sshare approve|reject [all]</Text>
        </Box>
      </Box>
    )
  })
}
