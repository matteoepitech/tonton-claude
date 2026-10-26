import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_ENTRIES_PER_SESSION, MAX_SHARE_BYTES, MAX_SHARES_PER_ACCOUNT } from '../src/limits'
import { Registry } from '../src/registry'
import { ShareStreams } from '../src/shares'

let dir: string
let registry: Registry

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tonton-shares-'))
  registry = new Registry(dir)
})

afterEach(() => {
  registry.close()
  rmSync(dir, { recursive: true, force: true })
})

const hour = () => Date.now() + 3_600_000

test('a share token opens its share while it runs, and only the account that made it lists or revokes it', () => {
  const owner = registry.createAccount().id
  const other = registry.createAccount().id
  const created = registry.createShare(owner, 'ses_1', hour())
  if (!created) throw new Error('no share')
  expect(created.token).toStartWith('ts_')
  expect(registry.authenticateShare(created.token)?.sessionId).toBe('ses_1')
  // An account token is not a share token, nor the reverse.
  expect(registry.authenticateShare(registry.createAccount().token)).toBeNull()
  expect(registry.authenticateAccount(created.token)).toBeNull()

  expect(registry.shares(other)).toEqual([])
  expect(registry.setShareOrder(other, created.share.id, 'ses_1', 'sealed')).toBe(false)
  expect(registry.setShareOrder(owner, created.share.id, 'ses_2', 'sealed')).toBe(false)
  expect(registry.setShareOrder(owner, created.share.id, 'ses_1', 'sealed')).toBe(true)
  expect(registry.shares(owner, 'ses_1').map(share => share.order)).toEqual(['sealed'])
  expect(registry.revokeShare(other, created.share.id)).toBeNull()
  expect(registry.revokeShare(owner, created.share.id)?.id).toBe(created.share.id)
  expect(registry.authenticateShare(created.token)).toBeNull()
})

test('an expired share opens nothing and is pruned, and an account holds a bounded number', () => {
  const owner = registry.createAccount().id
  const expired = registry.createShare(owner, 'ses_1', Date.now() - 1)
  if (!expired) throw new Error('no share')
  expect(registry.authenticateShare(expired.token)).toBeNull()
  expect(registry.shares(owner)).toEqual([])
  expect(registry.expireShares().map(share => share.id)).toEqual([expired.share.id])

  for (let i = 0; i < MAX_SHARES_PER_ACCOUNT; i++) expect(registry.createShare(owner, 'ses_1', hour())).not.toBeNull()
  expect(registry.createShare(owner, 'ses_1', hour())).toBeNull()
  // Deleting the account deletes its shares.
  registry.deleteAccount(owner)
  expect(registry.shares(owner)).toEqual([])
})

test('the sealed copy of a share is bounded, oldest first, and starts over on reset', () => {
  const streams = new ShareStreams()
  const entry = (i: number, size = 10) => ({ id: `e${i}`, ts: 't', blob: 'x'.repeat(size) })
  const many = Array.from({ length: MAX_ENTRIES_PER_SESSION + 5 }, (_, i) => entry(i))
  expect(streams.addEntries('sh1', many, false)).toHaveLength(many.length)
  expect(streams.get('sh1').entries).toHaveLength(MAX_ENTRIES_PER_SESSION)
  expect(streams.get('sh1').entries[0].id).toBe('e5')
  // Entries it holds already are not new.
  expect(streams.addEntries('sh1', [entry(10)], false)).toEqual([])

  const big = MAX_SHARE_BYTES / 2 + 1
  streams.addEntries('sh1', [entry(1, big), entry(2, big)], true)
  expect(streams.get('sh1').entries.map(e => e.id)).toEqual(['e2'])
  streams.drop('sh1')
  expect(streams.get('sh1')).toEqual({ info: null, entries: [] })
})
