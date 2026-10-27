// The island's calls to a real relay: an account made from the island signs in, its machines join with the token it
// gives, and its socket opens with the bearer token in the header, the way the main process sends it.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../relay/src/config'
import { startRelay } from '../../relay/src/main'
import { parseAccountToken } from '../../shared/account-token'
import { seal } from '../../shared/crypto'
import { appSocketUrl } from '../../shared/recovery-key'
import { createAccount, installCommand, joinSecret, machineToken, RelayError, verifyAccount } from '../src/main/relay-api'

const dir = mkdtempSync(join(tmpdir(), 'tonton-island-relay-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: dir }))
const base = `http://127.0.0.1:${relay.server.port}`

afterAll(() => {
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

test('an account made here has its key, its token for machines, and opens the app socket', async () => {
  const account = await createAccount(base, fetch)
  expect(account.relay).toBe(base)
  expect(account.key).toMatch(/^[A-Za-z0-9_-]{43}$/)
  await verifyAccount(account, fetch)

  const token = machineToken(account)
  const parsed = token ? parseAccountToken(token) : null
  expect(parsed).toEqual({ relay: base, account: account.accountId, secret: account.joinSecret ?? '', key: account.key })
  const joined = await fetch(`${base}/api/machines/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: account.accountId, secret: account.joinSecret, name: await seal(account.key, { name: 'PC' }) }),
  })
  expect(joined.status).toBe(200)

  const first = await new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(appSocketUrl(account.relay), { headers: { authorization: `Bearer ${account.token}` } } as never)
    socket.onmessage = event => {
      resolve(String(event.data))
      socket.close()
    }
    socket.onerror = () => reject(new Error('refused'))
  })
  expect(JSON.parse(first).t).toBe('snapshot')
})

test("the relay's refusals come back as messages to show", async () => {
  const account = await createAccount(base, fetch)
  // The token exists already: it is on the computer that made it.
  await expect(joinSecret(account, fetch)).rejects.toThrow('This account already has a token')
  await expect(verifyAccount({ ...account, token: 'ta_not_a_real_token' }, fetch)).rejects.toThrow('no longer valid')
  await expect(createAccount('http://127.0.0.1:1', fetch)).rejects.toBeInstanceOf(RelayError)
})

test('the install commands carry the token like the Mac app writes them', () => {
  expect(installCommand('windows', 'tonton_abc')).toBe(
    "$env:TONTON_TOKEN='tonton_abc'; irm https://github.com/matteoepitech/tonton-claude/releases/latest/download/install.ps1 | iex",
  )
  expect(installCommand('unix', 'tonton_abc')).toBe(
    "curl -fsSL https://github.com/matteoepitech/tonton-claude/releases/latest/download/install.sh | TONTON_TOKEN='tonton_abc' sh",
  )
})
