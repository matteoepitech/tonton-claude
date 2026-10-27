import { afterEach, describe, expect, test } from 'bun:test'
import type { SealedEntry, SessionSummary } from '../../shared/protocol'
import { MAX_SESSION_BYTES } from '../src/limits'
import { SessionStore } from '../src/sessions'

const stores: SessionStore[] = []

function createStore() {
  const updates: { accountId: string; session: SessionSummary }[] = []
  const removals: string[] = []
  const store = new SessionStore({
    updated: (accountId, session) => updates.push({ accountId, session }),
    removed: (_accountId, sessionId) => removals.push(sessionId),
  })
  stores.push(store)
  return { store, updates, removals }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose()
})

const entry = (id: string, size = 10): SealedEntry => ({ id, ts: new Date().toISOString(), blob: 'x'.repeat(size) })

describe('SessionStore', () => {
  test('hooks drive the status', () => {
    const { store } = createStore()
    const hook = (hook_event_name: string, notification_type?: string) =>
      store.applyHook('acc', 'm1', { event: { hook_event_name, session_id: 's1', notification_type } })

    hook('SessionStart')
    expect(store.list('acc')[0].status).toBe('idle')
    hook('UserPromptSubmit')
    expect(store.list('acc')[0].status).toBe('working')
    hook('Notification', 'permission_prompt')
    expect(store.list('acc')[0].status).toBe('permission')
    hook('Notification', 'idle_prompt')
    expect(store.list('acc')[0].status).toBe('waiting')
    hook('SessionEnd')
    expect(store.list('acc')[0]).toMatchObject({ status: 'ended', canChat: false })
  })

  test('entries that come after Stop do not bring the wave back: the hooks keep the status', () => {
    const { store } = createStore()
    const hook = (hook_event_name: string) => store.applyHook('acc', 'm1', { event: { hook_event_name, session_id: 's1' } })
    store.agentConnected('acc', 'm1', 's1', 'info', true)
    hook('UserPromptSubmit')
    store.addEntries('acc', 's1', [entry('a1')], false)
    // The hook goes over HTTP, the entries over the agent's socket: the last answer can land after Stop.
    hook('Stop')
    store.addEntries('acc', 's1', [entry('a2')], false)
    expect(store.list('acc')[0].status).toBe('idle')
    // A new turn still shows: its prompt hook says so.
    hook('UserPromptSubmit')
    expect(store.list('acc')[0].status).toBe('working')
  })

  test('without any hook yet, new entries still mean the session works', () => {
    const { store } = createStore()
    store.agentConnected('acc', 'm1', 's1', 'info', true)
    store.addEntries('acc', 's1', [entry('a1')], false)
    expect(store.list('acc')[0].status).toBe('working')
  })

  test('accounts are isolated', () => {
    const { store } = createStore()
    store.agentConnected('alice', 'm1', 's1', 'info', true)
    expect(store.list('bob')).toEqual([])
    expect(store.history('bob', 's1')).toEqual([])
  })

  test('a machine cannot take over another machine session', () => {
    const { store } = createStore()
    expect(store.agentConnected('acc', 'm1', 's1', 'info', true)).toBe(true)
    expect(store.agentConnected('acc', 'm2', 's1', 'info', true)).toBe(false)
    store.applyHook('acc', 'm2', { event: { hook_event_name: 'SessionEnd', session_id: 's1' } })
    expect(store.list('acc')[0].status).not.toBe('ended')
  })

  test('entries are deduplicated and reset replaces the history', () => {
    const { store } = createStore()
    store.agentConnected('acc', 'm1', 's1', 'info', true)
    expect(store.addEntries('acc', 's1', [entry('a'), entry('b')], false)).toHaveLength(2)
    expect(store.addEntries('acc', 's1', [entry('b'), entry('c')], false).map(e => e.id)).toEqual(['c'])
    store.addEntries('acc', 's1', [entry('z')], true)
    expect(store.history('acc', 's1').map(e => e.id)).toEqual(['z'])
  })

  test('history stays within the per-session byte budget', () => {
    const { store } = createStore()
    store.agentConnected('acc', 'm1', 's1', 'info', true)
    const big = Math.floor(MAX_SESSION_BYTES / 3)
    store.addEntries('acc', 's1', [entry('1', big), entry('2', big), entry('3', big), entry('4', big)], false)
    const history = store.history('acc', 's1')
    expect(history.map(e => e.id)).toEqual(['2', '3', '4'])
    expect(history.reduce((sum, e) => sum + e.blob.length, 0)).toBeLessThanOrEqual(MAX_SESSION_BYTES)
  })

  test('a verdict closes the permission and resumes work', () => {
    const { store } = createStore()
    store.agentConnected('acc', 'm1', 's1', 'info', true)
    store.addPermission('acc', 's1', { requestId: 'abcde', ts: 'now', blob: 'sealed' })
    expect(store.list('acc')[0]).toMatchObject({ status: 'permission', pendingPermissions: [{ requestId: 'abcde' }] })
    store.closePermission('acc', 's1', 'abcde')
    expect(store.list('acc')[0]).toMatchObject({ status: 'working', pendingPermissions: [] })
  })

  test('removing a machine removes its sessions', () => {
    const { store, removals } = createStore()
    store.agentConnected('acc', 'm1', 's1', 'info', true)
    store.agentConnected('acc', 'm2', 's2', 'info', true)
    store.removeMachine('acc', 'm1')
    expect(store.list('acc').map(s => s.id)).toEqual(['s2'])
    expect(removals).toEqual(['s1'])
  })

  test('a name from a Mac is published without counting as activity, for sessions of the account only', () => {
    const { store, updates } = createStore()
    store.agentConnected('acc', 'm1', 's1', 'info', false)
    const before = store.list('acc')[0].lastActivity
    store.rename('acc', 's1', 'sealed-name')
    expect(updates.at(-1)?.session).toMatchObject({ id: 's1', name: 'sealed-name', lastActivity: before })
    store.rename('other', 's1', 'stolen')
    store.rename('acc', 'unknown', 'sealed')
    expect(store.list('acc')).toHaveLength(1)
    expect(store.list('acc')[0].name).toBe('sealed-name')
    expect(store.list('other')).toEqual([])
  })

  test('every change is published', () => {
    const { store, updates } = createStore()
    store.agentConnected('acc', 'm1', 's1', 'info', false)
    store.setMeta('acc', 's1', 'meta')
    expect(updates.map(u => u.session.meta)).toEqual([null, 'meta'])
  })
})
