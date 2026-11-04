// Tonton in the island, against a real relay: the main process reads and writes the hero's sealed document with the
// token, only that route and only that size, and the page's sync opens and seals it with the account key.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../relay/src/config'
import { startRelay } from '../../relay/src/main'
import { importAccountKey, open, type RPGState } from '../../shared'
import { grantRPGBooster } from '../../shared/rpg-loot'
import type { RPGRequest } from '../src/bridge'
import { createAccount, parseRPGRequest, rpgRequest } from '../src/main/relay-api'
import { HeroSync } from '../src/renderer/hero-sync'

const dir = mkdtempSync(join(tmpdir(), 'tonton-island-hero-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: dir }))
const base = `http://127.0.0.1:${relay.server.port}`

afterAll(() => {
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

async function eventually(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for ${what}`)
}

test('the page may only read the hero or replace it with a blob of a hero’s size', () => {
  expect(parseRPGRequest({ method: 'GET' })).toEqual({ method: 'GET' })
  expect(parseRPGRequest({ method: 'GET', body: 'ignored' })).toEqual({ method: 'GET' })
  expect(parseRPGRequest({ method: 'PUT', body: '{}' })).toEqual({ method: 'PUT', body: '{}' })
  for (const bad of [
    null,
    'GET',
    {},
    { method: 'DELETE' },
    { method: 'PUT' },
    { method: 'PUT', body: 3 },
    { method: 'PUT', body: 'x'.repeat(6 << 20) },
  ])
    expect(parseRPGRequest(bad)).toBeNull()
})

test('the main process carries the token; the relay answers as it would the website', async () => {
  const account = await createAccount(base, fetch)
  const first = await rpgRequest(account, { method: 'GET' }, fetch)
  expect(first).toEqual({ status: 200, body: JSON.stringify({ rev: 0, blob: null }) })
  // A stale revision is the relay's 409, passed on for the client core to retry.
  const stale = await rpgRequest(account, { method: 'PUT', body: JSON.stringify({ rev: 5, blob: 'x' }) }, fetch)
  expect(stale?.status).not.toBe(200)
  expect(await rpgRequest({ ...account, token: 'ta_not_a_real_token' }, { method: 'GET' }, fetch)).toMatchObject({ status: 401 })
  expect(await rpgRequest({ ...account, relay: 'http://127.0.0.1:1' }, { method: 'GET' }, fetch)).toBeNull()
})

test('the island opens the hero, saves a change through the main process, and reads it back', async () => {
  const account = await createAccount(base, fetch)
  const key = await importAccountKey(account.key)
  const asked: RPGRequest[] = []
  const bridge = {
    rpg: (request: RPGRequest) => {
      asked.push(request)
      return rpgRequest(account, request, fetch)
    },
  }
  const changes: (RPGState | null)[] = []
  const sync = new HeroSync(key, bridge, before => changes.push(before))
  sync.start()
  await eventually(() => sync.hero !== null, 'the first reading')
  expect(sync.hero?.xp).toBe(0)
  expect(changes).toEqual([null])

  const next = await sync.change(hero => grantRPGBooster(hero, 'level-2'))
  expect(next?.boosters).toEqual(['level-2'])
  expect(sync.hero?.boosters).toEqual(['level-2'])
  expect(asked.some(request => request.method === 'PUT')).toBe(true)
  // What the relay keeps is sealed with the account key, and the island reads it back.
  const stored = JSON.parse((await rpgRequest(account, { method: 'GET' }, fetch))?.body ?? '{}') as { rev: number; blob: string }
  expect(stored.rev).toBe(1)
  expect(((await open(key, stored.blob)) as RPGState).boosters).toEqual(['level-2'])
  expect(stored.blob).not.toContain('level-2')
  sync.stop()
})

test('an older relay leaves the island without Tonton, and says nothing went wrong', async () => {
  const account = await createAccount(base, fetch)
  const sync = new HeroSync(await importAccountKey(account.key), { rpg: async () => ({ status: 404, body: '{}' }) }, () => {})
  await sync.refresh()
  expect(sync.unavailable).toBe(true)
  expect(sync.hero).toBeNull()
  expect(sync.problem).toBeNull()
  const offline = new HeroSync(await importAccountKey(account.key), { rpg: async () => null }, () => {})
  await offline.refresh()
  expect(offline.unavailable).toBe(false)
  expect(offline.problem).toBe('Could not sync Tonton.')
})
