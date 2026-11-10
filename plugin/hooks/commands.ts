import type { EngineInterface } from 'claude-code'

import type { Mode } from '../types/protocol'
import type { Verdict } from './control'
import { bridgeCall, isSharing, refreshStatus, settle } from './control'
import { ensureBridge } from './process'
import type { Args } from './text'
import { LINK_NOTES, USAGE, bare, failureOf, linkKind, parseArgs, parseTtl, until } from './text'

async function shareLink($: EngineInterface, mode: Mode, { mode: approval, rest }: Args) {
  const ttlMs = parseTtl(rest[0] ?? '')

  if (ttlMs === 'invalid') {
    return `bad ttl "${rest[0] ?? ''}"\n${USAGE}`
  }

  if (approval !== null && approval !== 'approve' && approval !== 'auto') {
    return `bad --mode "${approval}" (approve or auto)\n${USAGE}`
  }

  if (mode === 'read' && approval !== null) {
    return '--mode only applies to edit links.'
  }

  await ensureBridge($)

  const link = await bridgeCall($, '/link', { mode, ttlMs, approve: approval !== 'auto' })
  const { isCopied } = await $.ui.copy({ text: link.url })
  const kind = linkKind(link)
  const head = isCopied
    ? `${kind} link copied to your clipboard (until ${until(link.expires)}). its token stays off screen:\n${bare(link.url)}`
    : `${kind} link (until ${until(link.expires)}). couldn't copy it, so here it is whole. anyone watching can see it:\n${link.url}`

  await refreshStatus($)

  return [head, LINK_NOTES.get(kind) ?? ''].filter((part) => part !== '').join('\n')
}

async function settleCommand($: EngineInterface, verdict: Verdict, { rest }: Args) {
  const count = await settle($, verdict, rest[0] === 'all')
  const done = verdict === 'approve' ? 'approved' : 'rejected'

  return count > 0 ? `${done} ${count} guest message(s).` : 'nothing waiting.'
}

async function listLinks($: EngineInterface) {
  if (!(await isSharing($))) {
    return 'not sharing.'
  }

  const { links } = await bridgeCall($, '/links', null)
  const rows = links.map(
    (link) => `${linkKind(link).padEnd(13)}  until ${until(link.expires)}  ${bare(link.url)}`,
  )

  return rows.length > 0 ? rows.join('\n') : 'sharing, but no active links.'
}

async function revokeLinks($: EngineInterface, { rest }: Args) {
  const [scope] = rest
  const mode = scope === 'read' || scope === 'edit' ? scope : null
  const { revoked } = await bridgeCall($, '/revoke', { mode })

  return `revoked ${revoked} link(s).`
}

async function stopSharing($: EngineInterface) {
  if (!(await isSharing($))) {
    return 'not sharing.'
  }

  await settle($, 'reject', true)

  try {
    await bridgeCall($, '/stop', null)
  } catch (cause) {
    $.ui.log(`session-share: stop: ${failureOf(cause).message}`, { to: 'debug' })
  }

  return 'stopped sharing. every viewer got kicked.'
}

function dispatchCommand($: EngineInterface, args: Args): Promise<string> {
  const { sub } = args

  if (sub === 'read' || sub === 'edit') {
    return shareLink($, sub, args)
  }

  if (sub === 'approve' || sub === 'reject') {
    return settleCommand($, sub, args)
  }

  if (sub === 'list') {
    return listLinks($)
  }

  if (sub === 'revoke') {
    return revokeLinks($, args)
  }

  return sub === 'stop' ? stopSharing($) : Promise.resolve(USAGE)
}

export async function runCommand($: EngineInterface, line: string) {
  const args = parseArgs(line)

  try {
    return await dispatchCommand($, args)
  } catch (cause) {
    return `session-share: ${failureOf(cause).message}`
  }
}
