import { init, Terminal } from 'ghostty-web'

import type { Delivery, Mode, RelayToViewer, ViewerToRelay } from '../plugin/types/protocol'

type Handlers<Message extends { type: string }> = {
  [Tag in Message['type']]: (message: Extract<Message, { type: Tag }>) => void
}

type Variant = 'success' | 'danger' | null

type Tone = 'ok' | 'bad' | ''

type View = {
  terminal: Terminal | null
  cols: number
  rows: number
  socket: WebSocket | null
  mode: Mode
  ended: boolean
}

const RECONNECT_MS = 1500
const ASK_MARGIN_PX = 28
const SID = location.pathname.split('/')[2] ?? ''
const TOKEN_KEY = `session-share:${SID}`

const view: View = { terminal: null, cols: 0, rows: 0, socket: null, mode: 'read', ended: false }

const ui = {
  term: element('term', HTMLDivElement),
  badge: element('badge', HTMLSpanElement),
  badgeText: element('badge-text', HTMLSpanElement),
  overlay: element('overlay', HTMLDivElement),
  overlayText: element('overlay-text', HTMLElement),
  ask: element('ask', HTMLElement),
  askHead: element('ask-head', HTMLElement),
  askToggle: element('ask-toggle', HTMLElement),
  askText: element('ask-text', HTMLTextAreaElement),
  askSend: element('ask-send', HTMLButtonElement),
  note: element('msg', HTMLElement),
}

const HANDLERS = {
  frame: ({ width, height, bytes }) => {
    terminalSized(width, height).write(Uint8Array.from(atob(bytes), (char) => char.charCodeAt(0)))
  },
  hello: ({ mode, online }) => {
    view.mode = mode
    showHost(online)
    showOverlay(online ? '' : 'waiting for the host…')
    ui.ask.classList.toggle('show', mode === 'edit')
    requestAnimationFrame(fit)
  },
  host: ({ online }) => {
    showHost(online)
    showOverlay(online ? '' : 'the host is offline. waiting…')
  },
  queued: (delivery) => {
    showDelivery(delivery)
    ui.askSend.disabled = false

    if (delivery.outcome !== 'refused') {
      ui.askText.value = ''
    }
  },
  closed: ({ reason }) => {
    view.ended = true
    showOverlay(reason)
    setBadge('ended', 'danger')
    ui.ask.classList.remove('show')
  },
} satisfies Handlers<RelayToViewer>

function element<Found extends HTMLElement>(id: string, kind: new () => Found): Found {
  const found = document.getElementById(id)

  if (!(found instanceof kind)) {
    throw new TypeError(`#${id} is missing from the page`)
  }

  return found
}

function dispatch<Message extends { type: string }>(table: Handlers<Message>, message: Message) {
  // SAFETY: Handlers holds, under each tag, the handler for exactly that member of Message
  const handler = table[message.type as Message['type']] as (message: Message) => void

  handler(message)
}

function takeToken() {
  const fromUrl = new URLSearchParams(location.hash.slice(1)).get('t')

  if (fromUrl === null) {
    return sessionStorage.getItem(TOKEN_KEY)
  }

  sessionStorage.setItem(TOKEN_KEY, fromUrl)
  history.replaceState(null, '', location.pathname)

  return fromUrl
}

function showOverlay(text: string) {
  ui.overlayText.textContent = text
  ui.overlay.classList.toggle('show', text !== '')
}

function setBadge(text: string, variant: Variant) {
  ui.badgeText.textContent = text

  if (variant === null) {
    delete ui.badge.dataset.variant
  } else {
    ui.badge.dataset.variant = variant
  }
}

function setNote(text: string, tone: Tone) {
  ui.note.textContent = text
  ui.note.className = tone
}

function showHost(online: boolean) {
  if (online) {
    setBadge(`live · ${view.mode === 'edit' ? 'can send' : 'watching'}`, 'success')
  } else {
    setBadge('host offline', 'danger')
  }
}

function showDelivery(delivery: Delivery) {
  if (delivery.outcome === 'refused') {
    setNote(`not sent: ${delivery.why}`, 'bad')
  } else if (delivery.outcome === 'sent') {
    setNote('sent ✓ (queued if busy)', 'ok')
  } else {
    setNote('waiting for the host to approve…', '')
  }
}

function terminalSized(cols: number, rows: number) {
  if (view.terminal !== null && cols === view.cols && rows === view.rows) {
    return view.terminal
  }

  view.cols = cols
  view.rows = rows
  view.terminal?.resize(cols, rows)
  view.terminal ??= openTerminal(cols, rows)
  requestAnimationFrame(fit)

  return view.terminal
}

function openTerminal(cols: number, rows: number) {
  const terminal = new Terminal({
    cols,
    rows,
    fontSize: 14,
    disableStdin: true,
    cursorBlink: false,
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  })

  terminal.open(ui.term)

  return terminal
}

function fit() {
  ui.term.style.transform = 'none'

  const box = ui.term.getBoundingClientRect()

  if (box.width === 0 || box.height === 0) {
    return
  }

  const reserve = ui.ask.classList.contains('show')
    ? ui.ask.getBoundingClientRect().height + ASK_MARGIN_PX
    : 0
  const room = innerHeight - reserve
  const scale = Math.min(innerWidth / box.width, room / box.height)

  ui.term.style.left = `${Math.max(0, (innerWidth - box.width * scale) / 2)}px`
  ui.term.style.top = `${Math.max(0, (room - box.height * scale) / 2)}px`
  ui.term.style.transform = `scale(${scale})`
}

function send(message: ViewerToRelay) {
  if (view.socket?.readyState === WebSocket.OPEN) {
    view.socket.send(JSON.stringify(message))
  }
}

function connect(token: string) {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  const socket = new WebSocket(`${scheme}://${location.host}/ws/view?sid=${SID}`)

  view.socket = socket
  socket.addEventListener('open', () => {
    send({ type: 'auth', token })
  })
  socket.addEventListener('message', ({ data }: MessageEvent<string>) => {
    // SAFETY: the relay is this socket's only peer, and it writes RelayToViewer messages
    dispatch(HANDLERS, JSON.parse(data) as RelayToViewer)
  })
  socket.addEventListener('close', () => {
    if (!view.ended) {
      setBadge('reconnecting…', 'danger')
      setTimeout(() => {
        connect(token)
      }, RECONNECT_MS)
    }
  })
}

function sendPrompt() {
  const text = ui.askText.value.trim()

  if (text === '' || view.socket?.readyState !== WebSocket.OPEN) {
    return
  }

  ui.askSend.disabled = true
  setNote('sending…', '')
  send({ type: 'prompt', text })
}

function onAskKey(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    sendPrompt()
  }
}

function toggleAsk() {
  const minimized = ui.ask.classList.toggle('min')

  ui.askToggle.textContent = minimized ? 'show' : 'hide'
  fit()
}

async function start() {
  const token = takeToken()

  if (token === null) {
    showOverlay('this link has no token.')

    return
  }

  await init()
  addEventListener('resize', fit)
  new ResizeObserver(fit).observe(ui.ask)
  ui.askSend.addEventListener('click', sendPrompt)
  ui.askText.addEventListener('keydown', onAskKey)
  ui.askHead.addEventListener('click', toggleAsk)
  connect(token)
}

await start()
