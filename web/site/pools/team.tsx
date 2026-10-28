// The Team tab: everyone in the pool with their machines, what each brings and what it works on, the invite, and the
// machines of this account not in the pool yet, added in one click.
import { CpuIcon, PlusIcon } from 'lucide-react'
import { machinePlanLabel, machinesToAdd } from '../../../shared'
import { Toolbar } from '../common'
import { plural } from '../format'
import { useStore } from '../store'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { InviteButton, OpenInvites } from './invites'
import { MachineList, StopEveryMachine } from './machines'
import { Members, NameDialog } from './members'
import type { TabProps } from './page'

export function Team({ pool, state }: TabProps) {
  const store = useStore()
  const me = state.members.find(member => member.account === store.account)
  const lead = pool.role === 'owner' || pool.role === 'admin'
  const machines = state.machines ?? []
  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <Toolbar
        title="Team"
        detail={`${plural(state.members.length, 'member')} · ${plural(machines.length, 'machine')} · ${plural(
          machines.reduce((sum, machine) => sum + (machine.profile?.capacity ?? 0), 0),
          'session',
        )} at once`}
      >
        <NameDialog poolId={pool.id} current={me?.profile?.name ?? ''} />
        <StopEveryMachine pool={pool} state={state} />
        {lead && <InviteButton pool={pool} state={state} />}
      </Toolbar>
      {pool.role !== 'viewer' && <AddMyMachines pool={pool} state={state} />}
      <Members
        pool={pool}
        state={state}
        machines={account =>
          machines.some(machine => machine.account === account) ? (
            <MachineList pool={pool} state={state} account={account} />
          ) : (
            <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">No machine in the pool yet.</p>
          )
        }
      />
      {lead && <OpenInvites pool={pool} state={state} />}
    </div>
  )
}

/** This account's machines that can work and are not in the pool: one click puts them in, as joining does. */
function AddMyMachines({ pool, state }: TabProps) {
  const store = useStore()
  const picks = machinesToAdd(store.state?.machines ?? [], { id: pool.id, name: state.info?.name, machines: state.machines }).filter(
    pick => pick.machine.online,
  )
  if (!picks.length) return null
  return (
    <Card className="flex flex-wrap items-center gap-3 p-3">
      <CpuIcon className="size-4 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-sm">
        {picks.length === 1 ? 'One of your machines is' : `${picks.length} of your machines are`} not in the pool:{' '}
        {picks.map(pick => `${pick.machine.name} (${machinePlanLabel(pick.profile)})`).join(', ')}.
      </span>
      <Button size="sm" variant="outline" onClick={() => void store.bringMachines(pool.id, picks)}>
        <PlusIcon />
        Add {picks.length === 1 ? 'it' : 'them'}
      </Button>
    </Card>
  )
}
