import type { BridgeToRelay } from '../types/protocol'
import { PANE, fail, readJson, send, state } from './core'

type Size = { cols: number; rows: number }

type HerdrLayout = {
  result?: { layout: { panes: { pane_id: string; rect: { width: number; height: number } }[] } }
}

type HerdrFrame = Omit<BridgeToRelay & { type: 'frame' }, 'type'> & { type: string }

type Observer = Bun.Subprocess<'ignore', 'pipe', 'ignore'>

const OBSERVE_RETRY_MS = 1000

async function* lines(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  let pending = ''

  for await (const chunk of stream) {
    const parts = (pending + decoder.decode(chunk, { stream: true })).split('\n')

    pending = parts.pop() ?? ''
    yield* parts.filter((line) => line !== '')
  }
}

async function paneSize(): Promise<Size | null> {
  const child = Bun.spawn(['herdr', 'pane', 'layout', '--pane', PANE], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const layout = readJson<HerdrLayout>(await new Response(child.stdout).text(), {})
  const rect = layout.result?.layout.panes.find((pane) => pane.pane_id === PANE)?.rect

  return rect === undefined ? null : { cols: rect.width, rows: rect.height }
}

export function restartObserve() {
  state.observer?.kill()
  state.observer = null

  if (state.size === null || state.stopping) {
    return
  }

  const { cols, rows } = state.size
  const child = Bun.spawn(
    ['herdr', 'terminal', 'session', 'observe', PANE, '--cols', `${cols}`, '--rows', `${rows}`],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
  )

  state.observer = child
  void pump(child)
}

async function pump(child: Observer) {
  for await (const line of lines(child.stdout)) {
    const frame = readJson<HerdrFrame | null>(line, null)

    if (frame?.type === 'terminal.frame') {
      const { bytes, full, width, height, seq } = frame

      send({ type: 'frame', bytes, full, width, height, seq })
    }
  }

  await child.exited

  if (state.observer === child && !state.stopping) {
    setTimeout(restartObserve, OBSERVE_RETRY_MS)
  }
}

export async function followPane() {
  const size = await paneSize()

  if (size === null && state.size === null) {
    fail(`herdr pane ${PANE} not found`)
  }

  if (size === null || (size.cols === state.size?.cols && size.rows === state.size.rows)) {
    return
  }

  state.size = size
  restartObserve()
}
