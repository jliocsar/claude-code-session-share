import { is } from 'valibot'

import { SID } from './schemas'
import { closeBridge, closeViewer, openBridge, startAuthTimer, sweep } from './session'
import type { SocketData } from './sockets'
import {
  isBridge,
  isViewer,
  onBridgeMessage,
  onViewerMessage,
  upgradeBridge,
  upgradeViewer,
} from './sockets'

const PORT = Number(process.env.PORT ?? 8000)
const SWEEP_MS = 10_000
const MAX_PAYLOAD = 4 * 1024 * 1024

const PAGE_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self' data:; img-src 'self' data:",
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
}

function asset(path: string, type: string) {
  return new Response(Bun.file(new URL(path, import.meta.url)), {
    headers: { ...PAGE_HEADERS, 'content-type': type },
  })
}

async function buildViewer() {
  const build = await Bun.build({
    entrypoints: [new URL('viewer.ts', import.meta.url).pathname],
    target: 'browser',
    minify: true,
  })
  const [bundle] = build.outputs

  if (bundle === undefined) {
    throw new AggregateError(build.logs, 'the viewer did not build')
  }

  return new Response(await bundle.text(), {
    headers: { ...PAGE_HEADERS, 'content-type': 'text/javascript; charset=utf-8' },
  })
}

if ((process.env.SESSION_SHARE_SECRET ?? '').length < 32) {
  throw new Error('SESSION_SHARE_SECRET missing or too short')
}

setInterval(sweep, SWEEP_MS)

Bun.serve({
  port: PORT,
  routes: {
    '/': Response.json({ ok: "you're a teapot" }, { status: 418 }),
    '/s/:sid': (request) =>
      is(SID, request.params.sid)
        ? asset('viewer.html', 'text/html; charset=utf-8')
        : new Response('not found\n', { status: 404 }),
    '/viewer.js': await buildViewer(),
    '/viewer.css': asset('viewer.css', 'text/css; charset=utf-8'),
    '/vendor/oat.min.css': new Response(
      Bun.file(new URL('node_modules/@knadh/oat/oat.min.css', import.meta.url)),
      {
        headers: {
          'content-type': 'text/css; charset=utf-8',
          'cache-control': 'public, max-age=86400',
        },
      },
    ),
    '/ws/bridge': upgradeBridge,
    '/ws/view': upgradeViewer,
  },
  fetch: () => new Response('not found\n', { status: 404 }),
  websocket: {
    // SAFETY: Bun reads this only as the type of `ws.data`, set by the two upgrade routes
    data: {} as SocketData,
    maxPayloadLength: MAX_PAYLOAD,
    open: (socket) => {
      if (isBridge(socket)) {
        openBridge(socket)
      }

      if (isViewer(socket)) {
        startAuthTimer(socket)
      }
    },
    message: (socket, raw) => {
      if (isBridge(socket)) {
        onBridgeMessage(socket, `${raw}`)
      }

      if (isViewer(socket)) {
        onViewerMessage(socket, `${raw}`)
      }
    },
    close: (socket) => {
      if (isBridge(socket)) {
        closeBridge(socket)
      }

      if (isViewer(socket)) {
        closeViewer(socket)
      }
    },
  },
})
console.log(`session-share relay on :${PORT}`)
