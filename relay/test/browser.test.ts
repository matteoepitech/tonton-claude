// Browsers cannot set the Authorization header of a WebSocket: the web app puts the account token in a subprotocol.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RelayToApp } from '../../shared/protocol'
import { loadConfig } from '../src/config'
import { startRelay } from '../src/main'

const dir = mkdtempSync(join(tmpdir(), 'tonton-browser-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: dir }))
const ws = `ws://127.0.0.1:${relay.server.port}/ws/app`

afterAll(() => {
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

/** Opens like a browser does, with subprotocols and no headers. Resolves with the first message, or how it ended. */
function open(protocols: string[]): Promise<{ protocol: string; first: RelayToApp | null; closed: boolean }> {
  return new Promise(resolve => {
    const socket = new WebSocket(ws, protocols)
    const timer = setTimeout(() => resolve({ protocol: socket.protocol, first: null, closed: false }), 3000)
    socket.onmessage = event => {
      clearTimeout(timer)
      resolve({ protocol: socket.protocol, first: JSON.parse(String(event.data)), closed: false })
      socket.close()
    }
    socket.onerror = () => {}
    socket.onclose = () => {
      clearTimeout(timer)
      resolve({ protocol: socket.protocol, first: null, closed: true })
    }
  })
}

test('the account token in a subprotocol opens the app socket, and the relay answers without it', async () => {
  const account = await (await fetch(`http://127.0.0.1:${relay.server.port}/api/accounts`, { method: 'POST' })).json()
  const opened = await open(['tonton', `bearer.${account.token}`])
  expect(opened.first?.t).toBe('snapshot')
  expect(opened.protocol).toBe('tonton')
})

test('a wrong token, or a token without the tonton subprotocol, is refused', async () => {
  expect((await open(['tonton', 'bearer.ta_wrong'])).first).toBeNull()
  const account = await (await fetch(`http://127.0.0.1:${relay.server.port}/api/accounts`, { method: 'POST' })).json()
  expect((await open([`bearer.${account.token}`])).first).toBeNull()
})
