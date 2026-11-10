export type Pending = { id: string; text: string; viewer: string }

export type ShareState = {
  socket?: string
  sid?: string
  /** the share's page without a token: safe to draw, since viewers see this screen */
  page?: string
  read: number
  edit: number
  relay: boolean
}

declare module 'claude-code' {
  interface PluginState {
    sshare: {
      share: Shaped<ShareState>
      pending: Shaped<Pending[]>
    }
  }
}
