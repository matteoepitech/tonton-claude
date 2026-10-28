// Isolated two-worker pool fixture used by the reproducible gameplay demo.
import type { PoolState } from '../pool'

export function rpgDemoPool(): PoolState {
  const at = '2026-10-28T10:00:00.000Z'
  return {
    id: 'demopool0001',
    createdAt: at,
    info: { name: 'Isolated RPG demo', startedAt: at },
    paused: false,
    keyVersion: 1,
    members: ['alice', 'bob', 'viewer'].map(account => ({
      account,
      role: account === 'viewer' ? 'viewer' : 'member',
      joinedAt: at,
      profile: { name: account },
      publicKeys: [],
    })),
    tasks: Array.from({ length: 3 }, (_, i) => ({
      id: `task-${i}`,
      rev: 1,
      updatedAt: at,
      account: 'alice',
      session: 'claude',
      task: {
        title: 'Private task',
        state: 'done',
        completion: {
          at: `2026-10-28T10:0${i + 1}:00.000Z`,
          assignee: { account: i % 2 ? 'bob' : 'alice', session: i % 2 ? 'opencode' : 'claude' },
          reviewer: { account: i % 2 ? 'alice' : 'bob', session: 'review' },
        },
      },
    })),
    sessions: [],
    notes: null,
    messages: [],
    events: [],
    own: { secret: null, wraps: [] },
    rules: null,
    budgets: null,
    audit: [],
    orchestrator: null,
  }
}
