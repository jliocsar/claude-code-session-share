export type Pending = { id: string; text: string; viewer: string }

export type ShareState = {
  socket?: string
  sid?: string
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
