// The agent's socket to the relay: a relay that closes it right away is not opened again every second. Timings are short
// here; the agent waits 1 s at first, up to 30 s, and starts over once a connection held 30 s.
import { afterEach, expect, test } from 'bun:test'
import { newAccountKey } from '../../shared/crypto'
import { RelayConnection } from '../src/channel/relay-connection'

const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

/** A relay that keeps each socket open as long as `holds` says, in order, then closes it: right away once they run out. */
function closingRelay(holds: number[] = []) {
  const opened: number[] = []
  const closed: number[] = []
  const server = Bun.serve({
    port: 0,
    fetch: (request, server) => (server.upgrade(request) ? undefined : new Response('upgrade', { status: 400 })),
    websocket: {
      open(socket) {
        opened.push(Date.now())
        const hold = holds[opened.length - 1] ?? 0
        if (hold) setTimeout(() => socket.close(), hold)
        else socket.close()
      },
      message() {},
      close() {
        closed.push(Date.now())
      },
    },
  })
  const config = { server: `http://127.0.0.1:${server.port}`, machineId: 'machine00001', token: 't', key: newAccountKey(), machine: 'Test' }
  const connection = new RelayConnection(config, 'channel', { connected: () => {}, message: () => {} }, { backoffMs: 20, stableMs: 200 })
  stops.push(
    () => connection.stop(),
    () => server.stop(true),
  )
  connection.connect()
  return { opened, closed }
}

async function eventually(condition: () => boolean, label: string) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for ${label}`)
}

test('the wait before reconnecting grows while the relay closes the socket right after opening it', async () => {
  const { opened } = closingRelay()
  await eventually(() => opened.length >= 5, 'five connections')
  const waits = opened.slice(1).map((at, index) => at - opened[index])
  // 20, 40, 80 and 160 ms: opened again every 20 ms, the same message would go out each time.
  for (const [index, wait] of waits.entries()) expect(wait).toBeGreaterThanOrEqual(20 * 2 ** index - 5)
})

test('a connection that held starts the wait over', async () => {
  const { opened, closed } = closingRelay([0, 0, 0, 300])
  await eventually(() => opened.length >= 5, 'five connections')
  // After 20, 40 and 80 ms, the fourth held past 200 ms: the next one opens 20 ms after it closed, not 160.
  expect(opened[4] - closed[3]).toBeLessThan(120)
  expect(opened[3] - opened[2]).toBeGreaterThanOrEqual(75)
})
