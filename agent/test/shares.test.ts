import { expect, test } from 'bun:test'
import { newAccountKey, open, seal } from '../../shared/crypto'
import type { AgentMessage, Entry, ShareOrder } from '../../shared/protocol'
import { SessionShares } from '../src/channel/shares'

const accountKey = newAccountKey()
const entry = (id: string, text: string): Entry => ({ id, ts: '2026-10-26T10:00:00Z', kind: 'user', text })

/** A `SessionShares` for `ses_1`, with what it posts in order. */
function shares(backlog: Entry[] = []) {
  const sent: AgentMessage[] = []
  let outbox = Promise.resolve()
  const post = (build: () => Promise<AgentMessage | null>) => {
    outbox = outbox.then(async () => {
      const message = await build()
      if (message) sent.push(message)
    })
  }
  const set = new SessionShares(
    () => 'ses_1',
    accountKey,
    post,
    () => backlog,
  )
  return { set, sent, flushed: () => outbox }
}

const order = (fields: Partial<ShareOrder> = {}) =>
  seal(accountKey, {
    shareId: 'sh1',
    sessionId: 'ses_1',
    key: newAccountKey(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...fields,
  })

test('a share starts with the conversation so far, then gets each new entry, sealed with its key', async () => {
  const shareKey = newAccountKey()
  const { set, sent, flushed } = shares([entry('u1', 'hello')])
  set.setInfo({ project: 'shop', title: 'Fix' })
  set.receive('sh1', await order({ key: shareKey }))
  await flushed()
  set.entries([entry('u2', 'more')])
  await flushed()
  expect(sent.map(m => m.t)).toEqual(['share_info', 'share_entries', 'share_entries'])
  const [info, backlog, fresh] = sent
  if (info.t !== 'share_info' || backlog.t !== 'share_entries' || fresh.t !== 'share_entries') throw new Error('unexpected')
  expect(await open(shareKey, info.info)).toEqual({ project: 'shop', title: 'Fix' })
  expect(backlog.reset).toBe(true)
  expect(await open(shareKey, backlog.entries[0].blob)).toMatchObject({ text: 'hello' })
  expect(fresh.reset).toBe(false)
  expect(await open(shareKey, fresh.entries[0].blob)).toMatchObject({ text: 'more' })
})

test('orders for another session or share, expired, or not sealed with the account key are dropped', async () => {
  const { set, sent, flushed } = shares([entry('u1', 'hello')])
  set.receive('sh1', await order({ sessionId: 'ses_other' }))
  set.receive('sh1', await order({ shareId: 'sh2' }))
  set.receive('sh1', await order({ expiresAt: new Date(Date.now() - 1000).toISOString() }))
  set.receive(
    'sh1',
    await seal(newAccountKey(), { shareId: 'sh1', sessionId: 'ses_1', key: newAccountKey(), expiresAt: '2099-01-01T00:00:00Z' }),
  )
  set.entries([entry('u2', 'more')])
  await flushed()
  expect(sent).toEqual([])
})

test('once revoked, nothing more is sealed for the share; the info goes out only when it changes', async () => {
  const { set, sent, flushed } = shares()
  set.receive('sh1', await order())
  set.setInfo({ project: 'shop' })
  set.setInfo({ project: 'shop' })
  await flushed()
  expect(sent.filter(m => m.t === 'share_info')).toHaveLength(1)
  set.remove('sh1')
  set.entries([entry('u2', 'more')])
  set.setInfo({ project: 'shop', title: 'New' })
  await flushed()
  expect(sent.filter(m => m.t === 'share_entries' && !m.reset)).toEqual([])
})
