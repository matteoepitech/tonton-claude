// A pool's leaderboard: who got the most done, per session and per member, today, in this run of the pool or since it
// began. Tasks done and the time from each one's start to its end come from the pool's events; spending comes from what
// each session's agent shares.
import { TrophyIcon } from 'lucide-react'
import { useState } from 'react'
import { type LeaderPeriod, type LeaderRow, leaderboard } from '../../../shared'
import { Empty, Toolbar } from '../common'
import { compact, duration } from '../format'
import { cn } from '../ui/cn'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'
import type { TabProps } from './page'

const PERIODS: [LeaderPeriod, string][] = [
  ['today', 'Today'],
  ['run', 'This run'],
  ['all', 'All time'],
]

const periods = new Map<string, LeaderPeriod>()

export function Leaderboard({ pool, state }: TabProps) {
  const [period, setPeriod] = useState<LeaderPeriod>(() => periods.get(pool.id) ?? 'run')
  const { sessions, members } = leaderboard(state, period)
  return (
    <div className="flex flex-col gap-4">
      <Toolbar title="Leaderboard">
        <Tabs
          value={period}
          onValueChange={value => {
            periods.set(pool.id, value as LeaderPeriod)
            setPeriod(value as LeaderPeriod)
          }}
        >
          <TabsList className="h-8">
            {PERIODS.map(([id, label]) => (
              <TabsTrigger key={id} value={id}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </Toolbar>
      <h3 className="text-sm font-medium">Sessions</h3>
      <Table rows={sessions} withTool />
      <h3 className="text-sm font-medium">Members</h3>
      <Table rows={members} withTool={false} />
      <p className="text-xs text-muted-foreground">
        Time is from when a task started to when it was done. Spending is what each session’s agent shared with the pool.
      </p>
    </div>
  )
}

function Table({ rows, withTool }: { rows: LeaderRow[]; withTool: boolean }) {
  if (!rows.length) return <Empty className="py-2 text-left">Nobody yet.</Empty>
  const heads = ['#', withTool ? 'Session' : 'Member', ...(withTool ? ['Tool'] : []), 'Tasks done', 'Time', 'Spent', 'Tokens']
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-secondary text-xs text-muted-foreground">
          <tr>
            {heads.map(head => (
              <th key={head} className="px-3 py-2 text-left font-medium">
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.key} className={cn('border-t', index === 0 && row.tasksDone > 0 && 'bg-primary/10')}>
              <td className="px-3 py-2">{index === 0 && row.tasksDone > 0 ? <TrophyIcon className="size-4 text-warning" /> : index + 1}</td>
              <td className="px-3 py-2 font-medium">{row.name}</td>
              {withTool && <td className="px-3 py-2">{row.tool === 'opencode' ? 'OpenCode' : 'Claude Code'}</td>}
              <td className="px-3 py-2">{row.tasksDone}</td>
              <td className="px-3 py-2">{duration(row.secondsWorked)}</td>
              <td className="px-3 py-2">{row.costUSD === undefined ? '—' : `$${row.costUSD.toFixed(2)}`}</td>
              <td className="px-3 py-2">{row.tokens === undefined ? '—' : compact(row.tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
