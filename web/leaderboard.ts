// A pool's leaderboard: who got the most done, per session and per member, today, in this run of the pool or since it
// began. Tasks done and the time from each one's start to its end come from the pool's events; spending comes from what
// each session's agent shares. Lines changed are not shown: nothing in the pool carries them yet.

import { type LeaderPeriod, type LeaderRow, leaderboard, type OpenPool, type PoolState } from '../shared'
import { compact, duration } from './control'
import { element } from './markdown'
import type { PageControls, PoolsContext } from './pools'

const PERIODS: [LeaderPeriod, string][] = [
  ['today', 'Today'],
  ['run', 'This run'],
  ['all', 'All time'],
]

const periods = new Map<string, LeaderPeriod>()

export function renderLeaderboard(body: HTMLElement, pool: OpenPool, state: PoolState, context: PoolsContext, _page: PageControls) {
  const period = periods.get(pool.id) ?? 'run'
  const { sessions, members } = leaderboard(state, period)
  const switcher = element(
    'div',
    ...PERIODS.map(([id, label]) => {
      const button = element('button', label)
      button.setAttribute('aria-pressed', String(id === period))
      button.onclick = () => {
        periods.set(pool.id, id)
        context.rerender()
      }
      return button
    }),
  )
  switcher.className = 'periods'
  switcher.setAttribute('role', 'group')
  switcher.setAttribute('aria-label', 'Period')
  const toolbar = element('div', element('h2', 'Leaderboard'), switcher)
  toolbar.className = 'pool-toolbar'
  body.replaceChildren(
    toolbar,
    element('h3', 'Sessions'),
    table(sessions, true),
    element('h3', 'Members'),
    table(members, false),
    element('p', 'Time is from when a task started to when it was done. Spending is what each session’s agent shared with the pool.'),
  )
}

function table(rows: LeaderRow[], withTool: boolean): HTMLElement {
  if (!rows.length) return element('p', 'Nobody yet.')
  const head = element(
    'tr',
    ...['#', withTool ? 'Session' : 'Member', ...(withTool ? ['Tool'] : []), 'Tasks done', 'Time', 'Spent', 'Tokens'].map(text =>
      element('th', text),
    ),
  )
  const body = rows.map((row, index) => {
    const cells = [
      String(index + 1),
      row.name,
      ...(withTool ? [row.tool === 'opencode' ? 'OpenCode' : 'Claude Code'] : []),
      String(row.tasksDone),
      duration(row.secondsWorked),
      row.costUSD === undefined ? '—' : `$${row.costUSD.toFixed(2)}`,
      row.tokens === undefined ? '—' : compact(row.tokens),
    ]
    const tr = element('tr', ...cells.map(text => element('td', text)))
    if (index === 0 && row.tasksDone > 0) tr.className = 'first'
    return tr
  })
  const node = element('table', element('thead', head), element('tbody', ...body))
  node.className = 'leaderboard'
  const wrap = element('div', node)
  wrap.className = 'table-wrap'
  return wrap
}
