// The relay tells the app where it runs, in the response that upgrades the app's WebSocket.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config'
import { startRelay } from '../src/main'

const dir = mkdtempSync(join(tmpdir(), 'tonton-region-'))
const relays: { stop(): void }[] = []
afterAll(() => {
  for (const relay of relays) relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

test('the region comes from TONTON_REGION, or FLY_REGION on Fly.io', () => {
  expect(loadConfig({}).region).toBeNull()
  expect(loadConfig({ FLY_REGION: 'cdg' }).region).toBe('cdg')
  expect(loadConfig({ TONTON_REGION: ' Paris ', FLY_REGION: 'cdg' }).region).toBe('Paris')
})

/** The headers of the response to a hand-made WebSocket upgrade, which a WebSocket client does not expose. */
async function upgradeHeaders(region: string | undefined): Promise<string> {
  const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, region ?? 'none'), TONTON_REGION: region }))
  relays.push(relay)
  const port = relay.server.port ?? 0
  const { token } = await (await fetch(`http://127.0.0.1:${port}/api/accounts`, { method: 'POST' })).json()
  const request = [
    'GET /ws/app HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    `Authorization: Bearer ${token}`,
    '',
    '',
  ].join('\r\n')
  return new Promise((resolve, reject) => {
    let received = ''
    Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open: socket => void socket.write(request),
        data: (socket, chunk) => {
          received += chunk.toString()
          if (received.includes('\r\n\r\n')) {
            socket.end()
            resolve(received.split('\r\n\r\n')[0].toLowerCase())
          }
        },
        error: (_, error) => reject(error),
      },
    })
  })
}

test('the app socket upgrade carries the region when there is one', async () => {
  const withRegion = await upgradeHeaders('Paris')
  expect(withRegion).toStartWith('http/1.1 101')
  expect(withRegion).toContain('x-tonton-region: paris')
  const without = await upgradeHeaders(undefined)
  expect(without).toStartWith('http/1.1 101')
  expect(without).not.toContain('x-tonton-region')
})
