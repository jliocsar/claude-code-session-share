import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pending, ShareState } from '../types'

const IDLE: ShareState = { read: 0, edit: 0, relay: false }
const share = atom({ plugin: 'sshare', key: 'share' } as const, IDLE, { shape: 'share-1' })
const pending = atom({ plugin: 'sshare', key: 'pending' } as const, [] as Pending[], { shape: 'pending-1' })

const USAGE = [
  'usage:',
  '  /sshare read [ttl]                       watch-only link (ttl like 30m, 2h, 1d; default 2h)',
  '  /sshare edit [ttl] [--mode approve|auto] link that can send prompts; approve (default) holds each one for your ok',
  '  /sshare approve [all] | reject [all]     answer held guest messages (or press y/n on the band after ctrl+x tab)',
  '  /sshare list                             active links',
  '  /sshare revoke [read|edit]               kill links, keep sharing',
  '  /sshare stop                             stop sharing, kick everyone',
].join('\n')

// the module's own handle on the bridge; a reload starts it over (and kills the old child)
let starting: Promise<string> | undefined

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
    else if (w.startsWith('--mode=')) mode = w.slice(7)
    else rest.push(w)
  }
  return { sub, mode, rest }
}

function until(t: number) {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function showStatus($: EngineInterface, s: ShareState) {
  if (!s.socket) return $.ui.status(undefined)
  const who = s.read + s.edit
  const dot = s.relay ? '●' : '○'
  return $.ui.status(`${dot} sshare${who ? ` · ${who} watching${s.edit ? ` (${s.edit} can send)` : ''}` : ''}`)
}

async function bridgeCall($: EngineInterface, path: string, body?: unknown) {
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

async function submitGuest($: EngineInterface, p: Pending) {
  let ok = true
  let why: string | undefined
  try {
    void $.prompt.submit({ text: `[sshare guest via edit link]\n${p.text}` })
  } catch (err) {
    ok = false
    why = String(err)
  }
  await bridgeCall($, '/queued', { viewer: p.viewer, ok, why }).catch(() => {})
  return ok
}

async function answer($: EngineInterface, ids: 'first' | 'all', approve: boolean) {
  const list = await read($, pending)
  const picked = ids === 'all' ? list : list.slice(0, 1)
  if (!picked.length) return 0
  const gone = new Set(picked.map(p => p.id))
  await update($, pending, l => l.filter(p => !gone.has(p.id)))
  for (const p of picked) {
    if (approve) await submitGuest($, p)
    else await bridgeCall($, '/queued', { viewer: p.viewer, ok: false, why: 'the host declined it' }).catch(() => {})
  }
  return picked.length
}

async function onBridgeLine($: EngineInterface, m: any) {
  if (m.type === 'relay') {
    await showStatus($, await update($, share, s => ({ ...s, relay: m.online })))
  } else if (m.type === 'viewers') {
    const before = await read($, share)
    const after = await update($, share, s => ({ ...s, read: m.read, edit: m.edit }))
    if (m.read + m.edit > before.read + before.edit) await $.ui.toast('sshare: someone joined')
    await showStatus($, after)
  } else if (m.type === 'prompt') {
    const p: Pending = { id: crypto.randomUUID(), text: String(m.text), viewer: String(m.viewer) }
    if (m.approve === false) {
      if (await submitGuest($, p)) await $.ui.toast('sshare: guest message queued')
      return
    }
    await update($, pending, l => [...l, p].slice(-20))
    await bridgeCall($, '/queued', { viewer: p.viewer, ok: false, pending: true }).catch(() => {})
    await $.ui.toast('sshare: guest message waiting for your ok')
  } else if (m.type === 'fatal') {
    await $.ui.toast(`sshare: ${m.why}`)
  }
}

async function runBridge($: EngineInterface, resolve: (s: string) => void, reject: (e: Error) => void) {
  const pane = await $.env.get('HERDR_PANE_ID')
  if (!pane) return reject(new Error('this session is not inside a herdr pane, so there is no terminal to share'))
  const relay = await $.env.get('SSHARE_RELAY')
  const env: Record<string, string> = { SSHARE_PANE: pane }
  if (relay) env.SSHARE_RELAY = relay
  const child = $.process.spawn({ argv: ['bun', `${$.plugin.root}/bridge/bridge.ts`], env })
  let buf = ''
  let ready = false
  try {
    for await (const piece of child) {
      if (!('stream' in piece)) continue
      if (piece.stream === 'stderr') {
        await $.ui.log(piece.text, { to: 'debug' })
        continue
      }
      buf += piece.text
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let m: any
        try { m = JSON.parse(line) } catch { continue }
        if (m.type === 'ready') {
          ready = true
          await update($, share, () => ({ ...IDLE, socket: m.socket, sid: m.sid }))
          resolve(m.socket)
        } else if (m.type === 'fatal' && !ready) {
          reject(new Error(m.why))
        } else {
          await onBridgeLine($, m)
        }
      }
    }
  } catch (err) {
    if (!ready) reject(err instanceof Error ? err : new Error(String(err)))
  } finally {
    starting = undefined
    await update($, share, () => IDLE)
    await update($, pending, () => [])
    await $.ui.status(undefined)
    if (!ready) reject(new Error('the bridge exited before it was ready (is bun on PATH?)'))
  }
}

function ensureBridge($: EngineInterface): Promise<string> {
  if (starting) return starting
  const p = new Promise<string>((resolve, reject) => { void runBridge($, resolve, reject) })
  starting = p
  p.catch(() => { if (starting === p) starting = undefined })
  return p
}

async function runCommand($: EngineInterface, args: string) {
  const { sub, mode, rest } = parseArgs(args)
  if (sub === 'read' || sub === 'edit') {
    const ttlMs = parseTtl(rest[0])
    if (ttlMs === null) return `bad ttl "${rest[0]}"\n${USAGE}`
    if (mode !== undefined && mode !== 'approve' && mode !== 'auto') return `bad --mode "${mode}" (approve or auto)\n${USAGE}`
    if (sub === 'read' && mode) return '--mode only applies to edit links.'
    await ensureBridge($)
    const l = await bridgeCall($, '/link', { mode: sub, ttlMs, approve: mode !== 'auto' })
    await showStatus($, await read($, share))
    const warn =
      sub === 'read' ? ''
      : l.approve ? '\nguest messages wait for your ok: y/n on the band (ctrl+x tab) or /sshare approve|reject.'
      : '\nauto mode: anyone with this link can prompt this session (and its tools) without asking. share it carefully.'
    return `${sub}${sub === 'edit' ? ` (${l.approve ? 'approve' : 'auto'})` : ''} link (until ${until(l.expires)}):\n${l.url}${warn}`
  }
  if (sub === 'approve' || sub === 'reject') {
    const n = await answer($, rest[0] === 'all' ? 'all' : 'first', sub === 'approve')
    return n ? `${sub === 'approve' ? 'approved' : 'rejected'} ${n} guest message(s).` : 'nothing waiting.'
  }
  if (sub === 'list') {
    const s = await read($, share)
    if (!s.socket) return 'not sharing.'
    const r = await $.http.fetch('http://bridge/links', { socketPath: s.socket })
    const j = JSON.parse(r.text)
    if (!j.links.length) return 'sharing, but no active links.'
    return j.links
      .map((l: any) => `${(l.mode === 'edit' ? `edit/${l.approve ? 'approve' : 'auto'}` : 'read').padEnd(12)}  until ${until(l.expires)}  ${l.url}`)
      .join('\n')
  }
  if (sub === 'revoke') {
    const m = rest[0] === 'read' || rest[0] === 'edit' ? rest[0] : undefined
    const r = await bridgeCall($, '/revoke', { mode: m })
    return `revoked ${r.revoked} link(s).`
  }
  if (sub === 'stop') {
    const s = await read($, share)
    if (!s.socket) return 'not sharing.'
    await answer($, 'all', false)
    await bridgeCall($, '/stop').catch(() => {})
    return 'stopped sharing. every viewer got kicked.'
  }
  return USAGE
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
    if (!first || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const oneLine = first.text.replace(/\s+/g, ' ')
    const preview = oneLine.length > 160 ? `${oneLine.slice(0, 157)}…` : oneLine
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text>
          <Text color="yellow" bold>sshare guest wants to send</Text>
          {list.length > 1 ? <Text dimColor> (+{list.length - 1} more)</Text> : null}
        </Text>
        <Text>{preview}</Text>
        <Box gap={2}>
          <Button key="approve" hotkey="y" label="approve" variant="primary" onPress={() => answer($, 'first', true)} />
          <Button key="reject" hotkey="n" label="reject" onPress={() => answer($, 'first', false)} />
          {list.length > 1 ? <Button key="approve-all" hotkey="a" label="approve all" onPress={() => answer($, 'all', true)} /> : null}
          <Text dimColor>ctrl+x tab to focus · /sshare approve|reject [all]</Text>
        </Box>
      </Box>
    )
  })
}
