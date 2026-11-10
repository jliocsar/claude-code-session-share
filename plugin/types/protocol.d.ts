export type Mode = 'read' | 'edit'

export type TokenInfo = { hash: string; mode: Mode; expires: number }

export type Frame = {
  type: 'frame'
  bytes: string
  full: boolean
  width: number
  height: number
  seq: number
}

export type Delivery =
  | { outcome: 'sent' }
  | { outcome: 'pending' }
  | { outcome: 'refused'; why: string }

export type ViewerCounts = { read: number; edit: number }

/** Bridge stdout to the mod, one JSON object per line. */
export type BridgeEvent =
  | { type: 'ready'; sid: string; socket: string; page: string }
  | { type: 'relay'; online: boolean }
  | ({ type: 'viewers' } & ViewerCounts)
  | { type: 'prompt'; text: string; viewer: string; approve: boolean }
  | { type: 'fatal'; why: string }

/** A link as the bridge's control socket reports it (never the token's hash). */
export type LinkView = { mode: Mode; approve: boolean; url: string; expires: number }

/** The bridge's control socket: every route is a POST of `request`, answered with `response`. */
export type Control = {
  '/link': { request: { mode: Mode; ttlMs: number | null; approve: boolean }; response: LinkView }
  '/links': { request: null; response: { links: LinkView[] } }
  '/revoke': { request: { mode: Mode | null }; response: { revoked: number } }
  '/queued': { request: Delivery & { viewer: string }; response: { delivered: boolean } }
  '/stop': { request: null; response: { stopped: boolean } }
}

export type Route = keyof Control

export type BridgeToRelay =
  | { type: 'hello'; tokens: TokenInfo[] }
  | ({ type: 'token.add' } & TokenInfo)
  | { type: 'token.revoke'; hash: string }
  | Frame
  | ({ type: 'queued'; viewer: string } & Delivery)
  | { type: 'end' }

export type RelayToBridge =
  | { type: 'prompt'; text: string; viewer: string; hash: string }
  | ({ type: 'viewers' } & ViewerCounts)
  | { type: 'resync' }

export type ViewerToRelay = { type: 'auth'; token: string } | { type: 'prompt'; text: string }

export type RelayToViewer =
  | { type: 'hello'; mode: Mode; expires: number; online: boolean }
  | Frame
  | { type: 'host'; online: boolean }
  | ({ type: 'queued' } & Delivery)
  | { type: 'closed'; reason: string }
