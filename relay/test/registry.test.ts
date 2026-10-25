import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_MACHINES_PER_ACCOUNT } from '../src/limits'
import { Registry } from '../src/registry'

let dir: string
let registry: Registry

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tonton-registry-'))
  registry = new Registry(dir)
})

afterEach(() => {
  registry.close()
  rmSync(dir, { recursive: true, force: true })
})

const secrets = new Map<string, string>()

/** Joins a machine with the account token, created on first use. */
const enroll = (accountId: string, name = 'sealed-name') => {
  if (!secrets.has(accountId)) secrets.set(accountId, registry.newJoinSecret(accountId, false)?.secret ?? '')
  const result = registry.joinMachine(accountId, secrets.get(accountId) ?? '', name)
  if (!result.ok) throw new Error(result.reason)
  return result
}

describe('accounts', () => {
  test('authenticate with their token only', () => {
    const account = registry.createAccount()
    expect(registry.authenticateAccount(account.token)).toBe(account.id)
    expect(registry.authenticateAccount(account.token.replace(/.$/, c => (c === 'A' ? 'B' : 'A')))).toBeNull()
    expect(registry.authenticateAccount('ta_nope')).toBeNull()
  })

  test('deleting an account removes its machines', () => {
    const account = registry.createAccount()
    const { token } = enroll(account.id)
    registry.deleteAccount(account.id)
    expect(registry.authenticateAccount(account.token)).toBeNull()
    expect(registry.authenticateMachine(token)).toBeNull()
  })
})

describe('account token', () => {
  test('any number of machines join with it', () => {
    const account = registry.createAccount()
    const secret = registry.newJoinSecret(account.id, false)?.secret ?? ''
    expect(registry.joinMachine(account.id, secret, 'one').ok).toBe(true)
    expect(registry.joinMachine(account.id, secret, 'two').ok).toBe(true)
    expect(registry.machines(account.id)).toHaveLength(2)
  })

  test('a wrong secret or another account joins nothing', () => {
    const alice = registry.createAccount()
    const bob = registry.createAccount()
    const secret = registry.newJoinSecret(alice.id, false)?.secret ?? ''
    registry.newJoinSecret(bob.id, false)
    expect(registry.joinMachine(alice.id, `${secret}x`, 'blob')).toEqual({ ok: false, reason: 'invalid-token' })
    expect(registry.joinMachine(bob.id, secret, 'blob')).toEqual({ ok: false, reason: 'invalid-token' })
    expect(registry.joinMachine(registry.createAccount().id, secret, 'blob')).toEqual({ ok: false, reason: 'invalid-token' })
  })

  test('is kept unless regenerated', () => {
    const account = registry.createAccount()
    expect(registry.newJoinSecret(account.id, false)?.revoked).toEqual([])
    expect(registry.newJoinSecret(account.id, false)).toBeNull()
  })

  test('regenerating it signs out every machine and the previous token joins nothing', () => {
    const account = registry.createAccount()
    const previous = registry.newJoinSecret(account.id, false)?.secret ?? ''
    const { machine, token } = registry.joinMachine(account.id, previous, 'blob') as { machine: { id: string }; token: string }
    const next = registry.newJoinSecret(account.id, true)
    expect(next?.revoked).toEqual([machine.id])
    expect(registry.authenticateMachine(token)).toBeNull()
    expect(registry.joinMachine(account.id, previous, 'blob').ok).toBe(false)
    expect(registry.joinMachine(account.id, next?.secret ?? '', 'blob').ok).toBe(true)
  })

  test('machine tokens authenticate their machine', () => {
    const account = registry.createAccount()
    const { machine, token } = enroll(account.id)
    expect(registry.authenticateMachine(token)?.id).toBe(machine.id)
    expect(registry.authenticateMachine(account.token)).toBeNull()
  })

  test('an account cannot exceed its machine limit', () => {
    const account = registry.createAccount()
    for (let i = 0; i < MAX_MACHINES_PER_ACCOUNT; i++) enroll(account.id)
    expect(registry.joinMachine(account.id, secrets.get(account.id) ?? '', 'blob')).toEqual({ ok: false, reason: 'machine-limit' })
  })
})

describe('machines', () => {
  test('are listed per account and revoked only by their owner', () => {
    const alice = registry.createAccount()
    const bob = registry.createAccount()
    const { machine, token } = enroll(alice.id, 'alice-laptop')

    expect(registry.machines(alice.id).map(m => m.nameBlob)).toEqual(['alice-laptop'])
    expect(registry.machines(bob.id)).toEqual([])
    expect(registry.revokeMachine(bob.id, machine.id)).toBe(false)
    expect(registry.revokeMachine(alice.id, machine.id)).toBe(true)
    expect(registry.authenticateMachine(token)).toBeNull()
  })

  test('survive a reopen of the database', () => {
    const account = registry.createAccount()
    const { token } = enroll(account.id)
    registry.close()
    registry = new Registry(dir)
    expect(registry.authenticateMachine(token)).not.toBeNull()
  })
})
