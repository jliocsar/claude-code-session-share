// Every message between the mod, the bridge, the relay and the viewer page.
// Type-only: the bridge and the relay pull these in with `import type`, so the
// relay deploys without this file and the mod ships it as part of its contract.

export type Mode = 'read' | 'edit'

export type TokenInfo = { hash: string; mode: Mode; expires: number }

export type Frame = { type: 'frame'; bytes: string; full: boolean; width: number; height: number; seq: number }

export type Queued = { type: 'queued'; ok: boolean; pending?: boolean; why?: string }

/** Bridge stdout to the mod, one JSON object per line. */
export type BridgeEvent =
  | { type: 'ready'; sid: string; socket: string; page: string }
  | { type: 'relay'; online: boolean }
  | { type: 'viewers'; read: number; edit: number }
  | { type: 'prompt'; text: string; viewer: string; approve: boolean }
  | { type: 'fatal'; why: string }

/** A link as the bridge's control socket reports it (never the token's hash). */
export type LinkView = { mode: Mode; approve: boolean; url: string; expires: number }

export type BridgeToRelay =
  | { type: 'hello'; tokens: TokenInfo[] }
  | ({ type: 'token.add' } & TokenInfo)
  | { type: 'token.revoke'; hash: string }
  | Frame
  | (Queued & { viewer: string })
  | { type: 'end' }

export type RelayToBridge =
  | { type: 'prompt'; text: string; viewer: string; hash: string }
  | { type: 'viewers'; read: number; edit: number }
  | { type: 'resync' }

export type ViewerToRelay = { type: 'auth'; token: string } | { type: 'prompt'; text: string }

export type RelayToViewer =
  | { type: 'hello'; mode: Mode; expires: number; online: boolean }
  | Frame
  | { type: 'host'; online: boolean }
  | Queued
  | { type: 'closed'; reason: string }
