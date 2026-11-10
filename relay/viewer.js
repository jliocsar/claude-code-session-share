// session-share viewer: draws the shared terminal with ghostty-web and, on edit links, sends prompts.
import { init, Terminal } from '/vendor/ghostty-web.js'

const $ = id => document.getElementById(id)
const sid = location.pathname.split('/')[2]

// keep the token out of the address bar once read; a reload finds it in sessionStorage
const fromUrl = new URLSearchParams(location.hash.slice(1)).get('t')
if (fromUrl) {
  sessionStorage.setItem(`session-share:${sid}`, fromUrl)
  history.replaceState(null, '', location.pathname)
}
const token = fromUrl || sessionStorage.getItem(`session-share:${sid}`)

function overlay(text) {
  $('overlay-text').textContent = text
  $('overlay').classList.toggle('show', !!text)
}

function badge(text, cls = '') {
  $('badge-text').textContent = text
  $('badge').className = cls
}

function note(text, cls = '') {
  $('msg').textContent = text
  $('msg').className = cls
}

if (!token) {
  overlay('this link has no token.')
  throw new Error('no token')
}

await init()

// ---- terminal, scaled to fit above the prompt box

let term
let cols = 0
let rows = 0

function ensureTerm(w, h) {
  if (term && w === cols && h === rows) return
  cols = w
  rows = h
  if (term) term.resize(cols, rows)
  else {
    term = new Terminal({
      cols,
      rows,
      fontSize: 14,
      disableStdin: true,
      cursorBlink: false,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      theme: { background: '#16161e', foreground: '#c0caf5' },
    })
    term.open($('term'))
  }
  requestAnimationFrame(fit)
}

function fit() {
  const el = $('term')
  el.style.transform = 'none'
  const r = el.getBoundingClientRect()
  if (!r.width || !r.height) return
  const ask = $('ask')
  const reserve = ask.classList.contains('show') ? ask.getBoundingClientRect().height + 28 : 0
  const avail = innerHeight - reserve
  const s = Math.min(innerWidth / r.width, avail / r.height)
  el.style.left = `${Math.max(0, (innerWidth - r.width * s) / 2)}px`
  el.style.top = `${Math.max(0, (avail - r.height * s) / 2)}px`
  el.style.transform = `scale(${s})`
}

addEventListener('resize', fit)
new ResizeObserver(fit).observe($('ask'))

// ---- relay socket

const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0))
let ws
let mode = 'read'
let ended = false // the relay closed us for good: don't reconnect

function showHost(online) {
  if (online) badge(`live · ${mode === 'edit' ? 'can send' : 'watching'}`, 'live')
  else badge('host offline', 'off')
}

const handlers = {
  frame(m) {
    ensureTerm(m.width, m.height)
    term.write(b64(m.bytes))
  },
  hello(m) {
    mode = m.mode
    showHost(m.online)
    overlay(m.online ? '' : 'waiting for the host…')
    $('ask').classList.toggle('show', mode === 'edit')
    requestAnimationFrame(fit)
  },
  host(m) {
    showHost(m.online)
    overlay(m.online ? '' : 'the host is offline. waiting…')
  },
  queued(m) {
    if (m.pending) note('waiting for the host to approve…')
    else if (m.ok) note('sent ✓ (queued if busy)', 'ok')
    else note(`not sent: ${m.why}`, 'bad')
    $('ask-send').disabled = false
    if (m.ok || m.pending) $('ask-text').value = ''
  },
  closed(m) {
    ended = true
    overlay(m.reason)
    badge('ended', 'off')
    $('ask').classList.remove('show')
  },
}

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/view?sid=${sid}`)
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }))
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data)
    handlers[m.type]?.(m)
  }
  ws.onclose = () => {
    if (ended) return
    badge('reconnecting…', 'off')
    setTimeout(connect, 1500)
  }
}
connect()

// ---- prompt box (edit links)

function sendPrompt() {
  const text = $('ask-text').value.trim()
  if (!text || ws.readyState !== WebSocket.OPEN) return
  $('ask-send').disabled = true
  note('sending…')
  ws.send(JSON.stringify({ type: 'prompt', text }))
}

$('ask-send').onclick = sendPrompt
$('ask-text').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
  e.preventDefault()
  sendPrompt()
})
$('ask-head').onclick = () => {
  const min = $('ask').classList.toggle('min')
  $('ask-toggle').textContent = min ? 'show' : 'hide'
  fit()
}
