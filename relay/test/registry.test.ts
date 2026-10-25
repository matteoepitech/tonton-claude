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

const enroll = (accountId: string, name = 'sealed-name') => {
  const { code } = registry.createEnrollment(accountId)
  const result = registry.claimEnrollment(code, name)
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

describe('enrollment', () => {
  test('a code enrolls exactly one machine', () => {
    const account = registry.createAccount()
    const { code } = registry.createEnrollment(account.id)
    const first = registry.claimEnrollment(code, 'blob')
    expect(first.ok).toBe(true)
    expect(registry.claimEnrollment(code, 'blob')).toEqual({ ok: false, reason: 'invalid-code' })
  })

  test('codes are case-insensitive and trimmed', () => {
    const account = registry.createAccount()
    const { code } = registry.createEnrollment(account.id)
    expect(registry.claimEnrollment(`  ${code.toLowerCase()} `, 'blob').ok).toBe(true)
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
    const { code } = registry.createEnrollment(account.id)
    expect(registry.claimEnrollment(code, 'blob')).toEqual({ ok: false, reason: 'machine-limit' })
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
