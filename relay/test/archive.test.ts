// Sessions written to disk by the store come back as they were when the relay starts again, within the same limits.
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SealedEntry } from '../../shared/protocol'
import { SessionArchive } from '../src/archive'
import { FINISHED_SESSION_TTL_MS, MAX_SESSION_BYTES } from '../src/limits'
import { Registry } from '../src/registry'
import { SessionStore } from '../src/sessions'

let dir: string
let registry: Registry
let archive: SessionArchive
let store: SessionStore
let removals: string[]

const open = () => {
  registry = new Registry(dir)
  archive = new SessionArchive(registry.db)
  removals = []
  store = new SessionStore({ updated: () => {}, removed: (_accountId, sessionId) => removals.push(sessionId) }, archive)
}

/** What a relay does when it stops, then starts again on the same data. */
const restart = () => {
  store.dispose()
  archive.close()
  registry.close()
  open()
}

/** An account with machines that joined it. */
const account = (machines: number) => {
  const { id } = registry.createAccount()
  const secret = registry.newJoinSecret(id, false)?.secret ?? ''
  const ids = Array.from({ length: machines }, () => {
    const joined = registry.joinMachine(id, secret, 'sealed-name')
    if (!joined.ok) throw new Error(joined.reason)
    return joined.machine.id
  })
  return { id, machines: ids }
}

const entry = (id: string, size = 10): SealedEntry => ({ id, ts: new Date().toISOString(), blob: 'x'.repeat(size) })
const ids = (accountId: string, sessionId: string) => store.history(accountId, sessionId).map(e => e.id)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tonton-archive-'))
  open()
})

afterEach(() => {
  setSystemTime()
  store.dispose()
  archive.close()
  registry.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('sessions on disk', () => {
  test('come back with their sealed history, offline until their agent says hello again', () => {
    const { id, machines } = account(1)
    store.agentConnected(id, machines[0], 's1', 'sealed-info', true)
    store.setMeta(id, 's1', 'sealed-meta')
    store.addEntries(id, 's1', [entry('a'), entry('b')], false)
    store.addPermission(id, 's1', { requestId: 'abcde', ts: 'now', blob: 'sealed' })
    store.rename(id, 's1', 'sealed-name')
    const before = store.list(id)[0]
    expect(before.name).toBe('sealed-name')

    restart()
    expect(store.list(id)).toEqual([
      {
        ...before,
        status: 'offline',
        agentOnline: false,
        canChat: false,
        pendingPermissions: [],
      },
    ])
    expect(store.history(id, 's1')).toEqual([expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' })])

    expect(store.agentConnected(id, machines[0], 's1', 'sealed-info', true)).toBe(true)
    expect(store.list(id)[0]).toMatchObject({ status: 'idle', agentOnline: true })
  })

  test('an ended session stays ended', () => {
    const { id, machines } = account(1)
    store.agentConnected(id, machines[0], 's1', 'info', true)
    store.applyHook(id, machines[0], { event: { hook_event_name: 'SessionEnd', session_id: 's1' } })
    restart()
    expect(store.list(id)[0].status).toBe('ended')
  })

  test('the disk follows resets and the history limits', () => {
    const { id, machines } = account(1)
    store.agentConnected(id, machines[0], 's1', 'info', true)
    store.agentConnected(id, machines[0], 's2', 'info', true)
    store.addEntries(id, 's1', [entry('old')], false)
    store.addEntries(id, 's1', [entry('a'), entry('b')], true)
    const big = Math.floor(MAX_SESSION_BYTES / 3)
    store.addEntries(id, 's2', [entry('1', big), entry('2', big), entry('3', big), entry('4', big)], false)

    restart()
    expect(ids(id, 's1')).toEqual(['a', 'b'])
    expect(ids(id, 's2')).toEqual(['2', '3', '4'])
    // Ids already on disk are not stored twice.
    store.agentConnected(id, machines[0], 's1', 'info', true)
    expect(store.addEntries(id, 's1', [entry('b'), entry('c')], false).map(e => e.id)).toEqual(['c'])
    restart()
    expect(ids(id, 's1')).toEqual(['a', 'b', 'c'])
  })

  test('removed sessions, revoked machines and deleted accounts do not come back', () => {
    const alice = account(2)
    const bob = account(1)
    store.agentConnected(alice.id, alice.machines[0], 'kept', 'info', true)
    store.agentConnected(alice.id, alice.machines[0], 'dismissed', 'info', true)
    store.agentConnected(alice.id, alice.machines[1], 'revoked', 'info', true)
    store.agentConnected(bob.id, bob.machines[0], 'kept', 'info', true)
    store.addEntries(bob.id, 'kept', [entry('bob')], false)
    store.remove(alice.id, 'dismissed')
    // The relay crashed between revoking the machine and forgetting its sessions.
    registry.revokeMachine(alice.id, alice.machines[1])

    restart()
    expect(store.list(alice.id).map(s => s.id)).toEqual(['kept'])
    expect(ids(bob.id, 'kept')).toEqual(['bob'])
    expect(store.history(alice.id, 'kept')).toEqual([])

    registry.deleteAccount(bob.id)
    store.removeAccount(bob.id)
    restart()
    expect(store.list(bob.id)).toEqual([])
    expect(store.list(alice.id).map(s => s.id)).toEqual(['kept'])
  })

  test('finished sessions expire as they do in memory, restart or not', () => {
    const { id, machines } = account(1)
    const start = Date.now()
    setSystemTime(start - FINISHED_SESSION_TTL_MS - 60_000)
    store.agentConnected(id, machines[0], 'stale', 'info', true)
    store.agentDisconnected(id, 'stale')
    setSystemTime(start)
    store.agentConnected(id, machines[0], 'recent', 'info', true)
    store.agentDisconnected(id, 'recent')

    restart()
    expect(store.list(id).map(s => s.id)).toEqual(['recent'])
    expect(removals).toEqual(['stale'])
    restart()
    expect(store.list(id).map(s => s.id)).toEqual(['recent'])
  })

  test('changes after the archive closed are ignored', () => {
    const { id, machines } = account(1)
    store.agentConnected(id, machines[0], 's1', 'info', true)
    archive.close()
    store.addEntries(id, 's1', [entry('late')], false)
    store.agentDisconnected(id, 's1')
    expect(() => archive.flush()).not.toThrow()
  })
})
