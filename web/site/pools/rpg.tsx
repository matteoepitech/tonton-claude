// Shared standings use durable pool contributions, not token spending or private combat rewards.
import { useEffect, useRef, useState } from 'react'
import {
  claimRPGTeam,
  type LeaderPeriod,
  RPG_TEAM_TARGETS,
  type RPGPoolLedger,
  rpgGoalId,
  rpgRunStart,
  rpgStandings,
  syncRPGPool,
} from '../../../shared'
import { HeroAvatar, useHero } from '../rpg'
import { useStore } from '../store'
import { Button } from '../ui/button'
import type { TabProps } from './page'

export function RPGStandings({ pool, state, period }: TabProps & { period: LeaderPeriod }) {
  const store = useStore()
  const { hero, busy, error, change } = useHero()
  const latest = useRef({ state, hero })
  latest.current = { state, hero }
  const [ledger, setLedger] = useState<RPGPoolLedger | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const saved = store.saved
  const watch = store.pools
  const account = store.account
  useEffect(() => {
    let stopped = false
    let syncing = false
    setLedger(null)
    const refresh = async () => {
      if (!saved || !account || syncing) return
      const client = watch?.rpgClient(pool.id, saved.token)
      if (!client) return
      syncing = true
      try {
        const current = latest.current
        const next =
          pool.role === 'viewer'
            ? (await client.read()).ledger
            : await client.change(l => syncRPGPool(l, current.state, account, current.hero ?? undefined))
        if (!stopped) {
          setLedger(next)
          setProblem(null)
        }
      } catch {
        if (!stopped) setProblem('Team progression is unavailable. Check the connection and update the relay if needed.')
      } finally {
        syncing = false
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [pool.id, pool.role, saved, account, watch])
  const count = Object.values(ledger?.completions ?? {}).filter(c => Date.parse(c.at) >= Date.parse(rpgRunStart(state))).length
  const eligible =
    hero &&
    account &&
    ledger &&
    Object.entries(ledger.goals).some(([id, g]) => g.eligible.includes(account) && !hero.boosters.includes(id) && !hero.openings[id])
  return (
    <section className="space-y-4">
      <h3 className="text-lg font-semibold">Tonton's team standings</h3>
      {(problem || error) && (
        <p role="alert" className="text-destructive">
          {problem ?? error}
        </p>
      )}
      {ledger && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr>
                {['Rank', 'Member', 'Lifetime level', 'Contribution XP'].map(h => (
                  <th key={h} className="p-3 text-left">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rpgStandings(ledger, state, period).map((row, i) => (
                <tr key={row.account} className="border-t">
                  <td className="p-3">{i + 1}</td>
                  <td className="flex items-center gap-3 p-3">
                    <HeroAvatar equipped={row.equipped} />
                    <span>
                      {row.name}
                      {row.account === account ? ' (you)' : ''}
                      {row.departed ? ' · left' : ''}
                    </span>
                  </td>
                  <td className="p-3">{row.level}</td>
                  <td className="p-3">{row.xp}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        50 XP per completed pool task, 20 per accepted review. Combat and solo work never affect this ranking. Today uses UTC; ties use
        account ID.
      </p>
      <h3 className="font-semibold">Shared goals · this run</h3>
      {RPG_TEAM_TARGETS.map(target => (
        <div key={target}>
          <p>
            {Math.min(count, target)}/{target} tasks · one booster per eligible contributor{' '}
            {ledger?.goals[rpgGoalId(state, target)] ? '· earned' : ''}
          </p>
          <progress className="w-full" aria-label={`Team goal: ${target} completed tasks`} value={Math.min(count, target)} max={target} />
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Contribute before a goal is reached to qualify. The roster locks when the goal is recorded. Offline and departed contributors can
        claim after returning; later joiners work toward the next goal. Previous earned rewards remain in the recap.
      </p>
      <Button
        disabled={busy || !eligible}
        onClick={() => {
          if (ledger && account) void change(h => claimRPGTeam(h, ledger, account))
        }}
      >
        Claim team boosters
      </Button>
      <details>
        <summary>Run reward recap</summary>
        {Object.entries(ledger?.goals ?? {}).map(([id, goal]) => (
          <p key={id} className="py-1 text-sm">
            {goal.at} · {goal.eligible.length} eligible contributors ·{' '}
            {account && goal.eligible.includes(account) ? 'You qualified' : 'Not eligible'}
          </p>
        ))}
      </details>
      {(pool.role === 'owner' || pool.role === 'admin') && (
        <Button
          variant="outline"
          onClick={() => {
            if (
              state.info &&
              window.confirm('Start a new competition run? Scores reset for this run; permanent heroes and earned rewards stay.')
            )
              void watch?.updateInfo(pool.id, { ...state.info, startedAt: new Date().toISOString() })
          }}
        >
          Start a new competition run
        </Button>
      )}
    </section>
  )
}
