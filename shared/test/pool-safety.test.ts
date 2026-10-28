import { describe, expect, test } from 'bun:test'
import { newAccountKey, seal } from '../crypto'
import {
  decodePoolBudgets,
  decodePoolEventBody,
  decodePoolRules,
  memberBudget,
  openPoolRulesAcceptance,
  overBudget,
  type PoolState,
  PoolVault,
  sealPoolRulesAcceptance,
} from '../pool'
import type { PoolSnapshot } from '../pool-protocol'
import { isPoolOrderType, parsePoolToAgent, parsePoolUpdate } from '../pool-wire'

const accountKey = newAccountKey()
const poolKey = newAccountKey()
const rules = [{ tool: 'Bash', pattern: 'make deploy *' }]

describe('pool rules', () => {
  test('an acceptance opens only for its session and pool, with the account key that sealed it', async () => {
    const sealed = await sealPoolRulesAcceptance(accountKey, { poolId: 'pool1', sessionId: 'ses_1', rev: 2, rules })
    expect(await openPoolRulesAcceptance(accountKey, sealed, 'ses_1', 'pool1')).toMatchObject({ rev: 2, rules })
    expect(await openPoolRulesAcceptance(accountKey, sealed, 'ses_2', 'pool1')).toBeNull()
    expect(await openPoolRulesAcceptance(accountKey, sealed, 'ses_1', 'pool2')).toBeNull()
    expect(await openPoolRulesAcceptance(newAccountKey(), sealed, 'ses_1', 'pool1')).toBeNull()
    // A rule that the agent's matcher would not take is left out.
    const odd = await seal(accountKey, {
      poolId: 'pool1',
      sessionId: 'ses_1',
      rev: 1,
      issuedAt: 'now',
      rules: [{ tool: '' }, { tool: 'Edit' }, { tool: 'Bash', pattern: 3 }, 'x'],
    })
    expect((await openPoolRulesAcceptance(accountKey, odd, 'ses_1', 'pool1'))?.rules).toEqual([{ tool: 'Edit' }])
  })

  test('proposals, budgets and spend events another member sealed are checked field by field', () => {
    expect(decodePoolRules({ rules: [...rules, { pattern: 'x' }], note: 'deploys' })).toEqual({ rules, note: 'deploys' })
    expect(decodePoolRules({ rules: 'all' })).toBeNull()
    expect(decodePoolBudgets({ pool: { costUSD: 50 }, member: { hours: 2, costUSD: -1 }, members: { acc: { costUSD: 'a' } } })).toEqual({
      pool: { costUSD: 50 },
      member: { hours: 2 },
    })
    expect(decodePoolEventBody({ kind: 'spend', costUSD: 1.5, seconds: 'long' })).toEqual({ kind: 'spend', costUSD: 1.5 })
  })
})

describe('budgets', () => {
  const state = (events: { account: string; session: string; costUSD: number; seconds: number }[], budgets: object) =>
    ({
      budgets: { rev: 1, updatedAt: 'now', account: 'owner', session: null, value: budgets },
      events: events.map((event, seq) => ({
        id: `e${seq}`,
        seq,
        ts: 'now',
        account: event.account,
        session: event.session,
        body: { kind: 'spend', costUSD: event.costUSD, seconds: event.seconds },
      })),
    }) as unknown as Pick<PoolState, 'events' | 'budgets'>

  test("a member's sessions add up against its cap, every member against the pool's", () => {
    const events = [
      { account: 'ana', session: 's1', costUSD: 3, seconds: 600 },
      { account: 'ana', session: 's2', costUSD: 2.5, seconds: 600 },
      { account: 'bob', session: 's3', costUSD: 4, seconds: 0 },
      // A later spend replaces the session's earlier one.
      { account: 'ana', session: 's1', costUSD: 3.4, seconds: 700 },
    ]
    expect(overBudget(state(events, { member: { costUSD: 6 } }), 'ana')).toBeNull()
    expect(overBudget(state(events, { member: { costUSD: 5.9 } }), 'ana')).toBe("This member's budget of $5.9 is spent")
    expect(overBudget(state(events, { member: { costUSD: 5.9 }, members: { ana: { costUSD: 100 } } }), 'ana')).toBeNull()
    expect(overBudget(state(events, { pool: { costUSD: 9 } }), 'bob')).toBe("The pool's budget of $9 is spent")
    expect(overBudget(state(events, { member: { hours: 0.3 } }), 'ana')).toBe("This member's budget of 0.3 h is used up")
    // What the session's own agent counted by now is newer than its last event.
    expect(overBudget(state(events, { member: { costUSD: 8 } }), 'bob', { session: 's3', costUSD: 8, seconds: 0 })).toBe(
      "This member's budget of $8 is spent",
    )
    expect(overBudget(state(events, {}), 'ana')).toBeNull()
    expect(memberBudget({ member: { hours: 1 }, members: { bob: { costUSD: 2 } } }, 'bob')).toEqual({ costUSD: 2 })
  })
})

describe('what the relay sends', () => {
  test('rules, budgets and the audit log fold into the state; a wrong shape is dropped', async () => {
    const vault = new PoolVault(poolKey)
    const snapshot: PoolSnapshot = {
      id: 'pool1',
      createdAt: 'now',
      paused: true,
      keyVersion: 1,
      info: await vault.seal({ name: 'Hackathon' }),
      members: [],
      sessions: [{ account: 'ana', session: 's1', joinedAt: 'now', profile: null, online: true, ready: true, accepted: 2 }],
      tasks: [],
      notes: null,
      messages: [],
      events: [],
      rules: { rev: 2, updatedAt: 'now', account: 'owner', session: null, blob: await vault.seal({ rules }) },
      budgets: null,
      audit: [{ seq: 1, ts: 'now', account: 'owner', session: null, action: 'paused' }],
    }
    const parsed = parsePoolUpdate(JSON.parse(JSON.stringify({ t: 'pool_snapshot', pool: snapshot })))
    if (parsed?.t !== 'pool_snapshot') throw new Error('the snapshot does not parse')
    let state = await vault.snapshot(parsed.pool)
    expect(state.rules?.value).toEqual({ rules })
    expect(state.sessions[0].accepted).toBe(2)
    expect(state.audit.map(line => line.action)).toEqual(['paused'])

    const budgets = parsePoolUpdate({
      t: 'pool_budgets',
      poolId: 'pool1',
      budgets: { rev: 1, updatedAt: 'now', account: 'owner', session: null, blob: await vault.seal({ pool: { costUSD: 20 } }) },
    })
    const audit = parsePoolUpdate({
      t: 'pool_audit',
      poolId: 'pool1',
      entry: { seq: 2, ts: 'now', account: 'owner', session: null, action: 'resumed', extra: 'dropped' },
    })
    if (!budgets || !audit) throw new Error('the updates do not parse')
    state = (await vault.apply(state, budgets)) as PoolState
    state = (await vault.apply(state, audit)) as PoolState
    expect(state.budgets?.value).toEqual({ pool: { costUSD: 20 } })
    expect(state.audit.at(-1)).toEqual({ seq: 2, ts: 'now', account: 'owner', session: null, action: 'resumed' })

    expect(
      parsePoolUpdate({ t: 'pool_audit', poolId: 'pool1', entry: { seq: 3, ts: 'now', account: 'x', session: null, action: 'hacked' } }),
    ).toBeNull()
    expect(parsePoolUpdate({ t: 'pool_rules', poolId: 'pool1', rules: { rev: 'one' } })).toBeNull()
  })

  test("the agent's stop and acceptance orders are read like the join order", () => {
    expect(parsePoolToAgent({ t: 'pool_stop', sessionId: 's', poolId: 'p' })).toEqual({ t: 'pool_stop', sessionId: 's', poolId: 'p' })
    expect(parsePoolToAgent({ t: 'pool_accept', sessionId: 's', poolId: 'p', acceptance: 'a' })).toMatchObject({ acceptance: 'a' })
    expect(parsePoolToAgent({ t: 'pool_accept', sessionId: 's', poolId: 'p' })).toBeNull()
    expect(parsePoolToAgent({ t: 'pool_join', sessionId: 's', poolId: 'p', order: 'o', acceptance: 'a' })).toMatchObject({
      acceptance: 'a',
    })
    expect(['pool_join', 'pool_left', 'pool_stop', 'pool_accept', 'pool_task'].map(isPoolOrderType)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ])
  })
})
