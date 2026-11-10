import { createHash, randomBytes } from 'node:crypto'

import type { Control, LinkView, TokenInfo } from '../types/protocol'
import { RELAY, SID, send } from './core'

type Link = LinkView & { token: string; hash: string }

const TTL_DEFAULT_MS = 2 * 3_600_000
const TTL_MIN_MS = 60_000
const TTL_MAX_MS = 7 * 86_400_000

const links = new Map<string, Link>()

function hashOf(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export function viewOf({ mode, approve, url, expires }: Link): LinkView {
  return { mode, approve, url, expires }
}

export function tokenInfos(): TokenInfo[] {
  return [...links.values()].map(({ hash, mode, expires }) => ({ hash, mode, expires }))
}

function clampTtl(ttlMs: number | null) {
  return Math.min(Math.max(ttlMs ?? TTL_DEFAULT_MS, TTL_MIN_MS), TTL_MAX_MS)
}

export function addLink({ mode, ttlMs, approve }: Control['/link']['request']): LinkView {
  const token = randomBytes(32).toString('base64url')
  const link: Link = {
    mode,
    approve,
    token,
    hash: hashOf(token),
    expires: Date.now() + clampTtl(ttlMs),
    url: `${RELAY}/s/${SID}#t=${token}`,
  }

  links.set(link.hash, link)
  send({ type: 'token.add', hash: link.hash, mode, expires: link.expires })

  return viewOf(link)
}

export function revoke(matches: (link: Link) => boolean) {
  const doomed = [...links.values()].filter(matches)

  for (const link of doomed) {
    links.delete(link.hash)
    send({ type: 'token.revoke', hash: link.hash })
  }

  return doomed.length
}

export function expireLinks() {
  const now = Date.now()

  revoke((link) => link.expires < now)
}

export function allLinks() {
  return [...links.values()].map(viewOf)
}

export function approves(hash: string) {
  return links.get(hash)?.approve ?? true
}
