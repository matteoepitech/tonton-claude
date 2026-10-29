// The plan the orchestrator proposed, waiting for an admin (shared/pool-plan.ts): what it says, each machine with the
// tasks it starts on, what comes later, and Accept. Accepting starts the dispatch; to change the plan, the admin tells
// the orchestrator in the chat, which proposes it again.
import { CheckIcon, CpuIcon, HourglassIcon, SparklesIcon } from 'lucide-react'
import { useState } from 'react'
import { type OpenPool, type PendingPlan, type PoolState, planLanes, poolAbilities } from '../../../shared'
import { InlineText } from '../common'
import { ago } from '../format'
import { useStore } from '../store'
import { Button } from '../ui/button'
import { Badge, Card } from '../ui/card'
import { cn } from '../ui/cn'

export function PlanCard({ pool, state, plan }: { pool: OpenPool; state: PoolState; plan: PendingPlan }) {
  const store = useStore()
  const [busy, setBusy] = useState(false)
  const lanes = planLanes(state, plan.body.proposal)
  const leads = poolAbilities(pool.role).chooseOrchestrator
  const count = plan.body.proposal.tasks.length
  const accept = async () => {
    setBusy(true)
    await store.pools?.acceptPlan(pool.id)
    setBusy(false)
  }
  return (
    <Card className="flex flex-col gap-3 border-primary/50 p-4">
      <div className="flex items-center gap-2.5">
        <span className="icon-tile size-7">
          <SparklesIcon className="size-4" />
        </span>
        <strong className="text-[15px] font-semibold">The orchestrator's plan</strong>
        <span className="text-xs text-muted-foreground">
          {count} task{count === 1 ? '' : 's'} · {ago(plan.ts)}
        </span>
      </div>
      {plan.body.text && <InlineText text={plan.body.text} className="text-sm" />}
      <div className="grid gap-2 sm:grid-cols-2">
        {lanes.map(lane => (
          <div key={lane.machine?.machine ?? 'later'} className="flex flex-col gap-1.5 rounded-md border bg-card px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <span className={cn('size-5', lane.machine ? 'icon-tile-ink' : 'icon-tile')}>
                {lane.machine ? <CpuIcon className="size-3" /> : <HourglassIcon className="size-3" />}
              </span>
              <strong className="truncate text-sm font-medium">{lane.machine ? lane.name : 'Later'}</strong>
              {lane.owner && <span className="truncate text-xs text-muted-foreground">{lane.owner}</span>}
            </div>
            {lane.detail && <span className="text-xs text-muted-foreground">{lane.detail}</span>}
            {!lane.machine && <span className="text-xs text-muted-foreground">Once what they wait for is done, or a slot frees</span>}
            <ul className="flex flex-col gap-1">
              {lane.tasks.map(item => (
                <li key={item.id} className="flex items-center gap-2 text-sm">
                  <span className="truncate">{item.task?.title}</span>
                  {item.task?.size === 'simple' && (
                    <Badge variant="secondary" className="ms-auto">
                      simple
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {leads ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void accept()} disabled={busy}>
            <CheckIcon />
            Accept and start
          </Button>
          <span className="text-xs text-muted-foreground">Or tell the orchestrator what to change: it proposes the plan again.</span>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Waiting for the owner or an admin to accept it.</p>
      )}
    </Card>
  )
}
