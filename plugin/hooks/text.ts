import type { ShareState } from '../types'
import type { LinkView } from '../types/protocol'

export type Args = { sub: string; mode: string | null; rest: string[] }

const PREVIEW_CHARS = 160
const MODE_FLAG = '--mode='
const TTL_PATTERN = /^(\d+)([mhd])$/u

export const USAGE = [
  'usage:',
  '  /share-session read [ttl]                       watch-only link (ttl like 30m, 2h, 1d; default 2h)',
  '  /share-session edit [ttl] [--mode approve|auto] link that can send prompts; approve (default) holds each one for your ok',
  '  /share-session approve [all] | reject [all]     answer held guest messages (or press y/n on the band after ctrl+x tab)',
  '  /share-session list                             active links',
  '  /share-session revoke [read|edit]               kill links, keep sharing',
  '  /share-session stop                             stop sharing, kick everyone',
].join('\n')

const TTL_UNITS = new Map([
  ['m', 60_000],
  ['h', 3_600_000],
  ['d', 86_400_000],
])

export const LINK_NOTES = new Map([
  ['read', ''],
  [
    'edit/approve',
    'guest messages wait for your ok: y/n on the band (ctrl+x tab) or /share-session approve|reject.',
  ],
  [
    'edit/auto',
    'auto mode: anyone with this link can prompt this session (and its tools) without asking. share it carefully.',
  ],
])

export function failureOf(cause: unknown) {
  return cause instanceof Error ? cause : new Error(JSON.stringify(cause))
}

export function parseTtl(word: string): number | null | 'invalid' {
  if (word === '') {
    return null
  }

  const match = TTL_PATTERN.exec(word)
  const unit = TTL_UNITS.get(match?.[2] ?? '')

  return match === null || unit === undefined ? 'invalid' : Number(match[1]) * unit
}

export function parseArgs(line: string): Args {
  const [sub = '', ...tail] = line
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== '')
  const flag = tail.findIndex((word) => word === '--mode' || word.startsWith(MODE_FLAG))
  const word = tail[flag] ?? ''
  const inline = word.startsWith(MODE_FLAG)

  if (flag === -1) {
    return { sub, mode: null, rest: tail }
  }

  return {
    sub,
    mode: inline ? word.slice(MODE_FLAG.length) : (tail[flag + 1] ?? ''),
    rest: tail.filter((_word, index) => index !== flag && (inline || index !== flag + 1)),
  }
}

export function bare(url: string) {
  return url.replace(/#.*/u, '')
}

export function until(expires: number) {
  return new Date(expires).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function linkKind({ mode, approve }: LinkView) {
  if (mode === 'read') {
    return 'read'
  }

  return approve ? 'edit/approve' : 'edit/auto'
}

export function statusText({ relay, read: readers, edit }: ShareState) {
  const dot = relay ? '●' : '○'
  const watching = readers + edit
  const senders = edit > 0 ? ` (${edit} can send)` : ''

  return watching > 0
    ? `${dot} session-share · ${watching} watching${senders}`
    : `${dot} session-share`
}

export function oneLine(text: string) {
  const flat = text.replace(/\s+/gu, ' ')

  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 3)}…` : flat
}
