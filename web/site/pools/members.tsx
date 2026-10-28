// Who is in the pool: members with their roles (changed, handed over, removed by those who may), the sessions working
// for it, and the machines members added for the autopilot, with the choice of the orchestrator.
import { CrownIcon, UserRoundXIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import {
  assignableRoles,
  canKick,
  hackathonRoleLabel,
  memberName,
  type PoolRole,
  type PoolState,
  poolAbilities,
  sessionName,
  sortedMembers,
} from '../../../shared'
import { Empty, Problem, Toolbar } from '../common'
import { plural } from '../format'
import { useStore } from '../store'
import { Button } from '../ui/button'
import { Badge, Card } from '../ui/card'
import { Confirm, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTrigger } from '../ui/dialog'
import { Field, Input } from '../ui/fields'
import { NativeSelect } from '../ui/select'
import type { TabProps } from './page'
import { roleLabel } from './roles'

export function Members({ pool, state }: TabProps) {
  const store = useStore()
  const watch = store.pools
  const me = state.members.find(member => member.account === store.account)
  const choose = poolAbilities(pool.role).chooseOrchestrator
  const [skipped, setSkipped] = useState<number | null>(null)
  return (
    <div className="flex flex-col gap-4">
      <Toolbar title="Members">
        <NameDialog poolId={pool.id} current={me?.profile?.name ?? ''} />
      </Toolbar>
      {skipped ? (
        <Problem onDismiss={() => setSkipped(null)}>{plural(skipped, 'member')} could not get the new key: send them a new invite.</Problem>
      ) : null}
      <div className="flex flex-col divide-y rounded-lg border">
        {sortedMembers(state).map(member => {
          const self = member.account === store.account
          const name = memberName(state, member.account)
          const roles = assignableRoles(pool.role, member.role, self)
          return (
            <div key={member.account} className="flex flex-wrap items-center gap-2 p-3">
              <span className="flex min-w-0 flex-1 flex-col">
                <strong className="font-medium">
                  {name}
                  {self ? ' (you)' : ''}
                </strong>
                <small className="text-xs text-muted-foreground">Joined {new Date(member.joinedAt).toLocaleDateString()}</small>
              </span>
              {roles.length ? (
                <NativeSelect
                  aria-label={`Role of ${name}`}
                  value={member.role}
                  onChange={event => void watch?.setRole(pool.id, member.account, event.target.value as Exclude<PoolRole, 'owner'>)}
                >
                  {[member.role, ...roles.filter(role => role !== member.role)].map(role => (
                    <option key={role} value={role}>
                      {roleLabel(role)}
                    </option>
                  ))}
                </NativeSelect>
              ) : (
                <Badge variant="secondary">{roleLabel(member.role)}</Badge>
              )}
              {pool.role === 'owner' && !self && (
                <Confirm
                  trigger={
                    <Button variant="outline" size="sm">
                      <CrownIcon />
                      Make owner
                    </Button>
                  }
                  title={`Hand the pool to ${name}?`}
                  description="You stay as an admin."
                  action="Make owner"
                  onConfirm={() => void watch?.transferOwnership(pool.id, member.account)}
                />
              )}
              {canKick(pool.role, member.role, self) && (
                <Confirm
                  trigger={
                    <Button variant="outline" size="sm" className="text-destructive">
                      <UserRoundXIcon />
                      Remove
                    </Button>
                  }
                  title={`Remove ${name}?`}
                  description="The pool gets a new key, which they never receive. Every open invite is revoked."
                  action="Remove"
                  onConfirm={async () => {
                    const left = await watch?.kick(pool.id, member.account)
                    setSkipped(left?.length ?? null)
                  }}
                />
              )}
            </div>
          )
        })}
      </div>
      <Sessions poolId={pool.id} state={state} choose={choose} />
      <Machines poolId={pool.id} state={state} choose={choose} />
    </div>
  )
}

function Sessions({ poolId, state, choose }: { poolId: string; state: PoolState; choose: boolean }) {
  const watch = useStore().pools
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Sessions</h3>
      {state.sessions.length ? (
        <div className="flex flex-col divide-y rounded-lg border">
          {state.sessions.map(session => {
            const profile = session.profile
            const what = [
              profile?.tool === 'opencode' ? 'OpenCode' : profile?.tool === 'claude' ? 'Claude Code' : null,
              profile?.area ? hackathonRoleLabel(profile.area) : null,
              profile?.machine,
              profile?.skills,
            ]
            // The relay says who leads: a profile could claim it.
            const leads = state.orchestrator?.account === session.account && state.orchestrator.session === session.session
            return (
              <div key={`${session.account}/${session.session}`} className="flex flex-wrap items-center gap-2 p-3">
                <span className="flex min-w-0 flex-1 flex-col">
                  <strong className="font-medium">
                    {sessionName(state, session)}
                    {leads && <Badge className="ms-2">orchestrator</Badge>}
                  </strong>
                  <small className="text-xs text-muted-foreground">{what.filter(Boolean).join(' · ')}</small>
                </span>
                <Badge variant={!session.online ? 'secondary' : session.ready ? 'success' : 'warning'}>
                  {!session.online ? 'offline' : session.ready ? 'ready' : 'joining'}
                </Badge>
                {choose &&
                  (leads ? (
                    <Button
                      variant="outline"
                      size="sm"
                      title="The pool then has no orchestrator until you choose another one."
                      onClick={() => watch?.setOrchestrator(poolId, null)}
                    >
                      Not the orchestrator
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      title="It plans the project and hands the tasks to the others."
                      onClick={() => watch?.setOrchestrator(poolId, { account: session.account, session: session.session })}
                    >
                      Make orchestrator
                    </Button>
                  ))}
              </div>
            )
          })}
        </div>
      ) : (
        <Empty className="py-2 text-left">No session works for the pool yet. Members put theirs in from the notch.</Empty>
      )}
    </section>
  )
}

/** The machines members added for the autopilot. The orchestrator machine is one of the admin's own. */
function Machines({ poolId, state, choose }: { poolId: string; state: PoolState; choose: boolean }) {
  const store = useStore()
  const machines = state.machines
  // Older relays have no pool machines at all.
  if (!machines) return null
  const lead = state.orchestratorMachine
  const names = new Map(store.state?.machines.map(machine => [machine.id, machine.name]))
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Machines</h3>
      {machines.length ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {machines.map(machine => {
            const profile = machine.profile
            const mine = machine.account === store.account
            const leads = lead?.account === machine.account && lead.machine === machine.machine
            const name = profile?.name ?? names.get(machine.machine) ?? 'A machine'
            return (
              <Card key={`${machine.account}/${machine.machine}`} className="flex flex-col gap-1.5 p-3">
                <div className="flex items-center gap-2">
                  <strong className="truncate">{name}</strong>
                  {leads && <Badge>orchestrator</Badge>}
                  <Badge className="ms-auto" variant={!machine.online ? 'secondary' : machine.ready ? 'success' : 'warning'}>
                    {!machine.online ? 'offline' : machine.ready ? 'ready' : 'update the agent'}
                  </Badge>
                </div>
                <small className="text-xs text-muted-foreground">
                  {[
                    memberName(state, machine.account) + (mine ? ' (you)' : ''),
                    profile ? (profile.tool === 'opencode' ? 'OpenCode' : 'Claude Code') : null,
                    profile ? `${plural(profile.capacity, 'session')} at once` : null,
                    profile ? `mode ${profile.mode}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
                {choose && mine && (
                  <div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        store.pools?.setOrchestratorMachine(poolId, leads ? null : { account: machine.account, machine: machine.machine })
                      }
                    >
                      {leads ? 'Not the orchestrator machine' : 'Make it the orchestrator machine'}
                    </Button>
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      ) : (
        <Empty className="py-2 text-left">No machine in the pool yet. Members add theirs from Settings › Machines in the Mac app.</Empty>
      )}
    </section>
  )
}

function NameDialog({ poolId, current }: { poolId: string; current: string }) {
  const store = useStore()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(current)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (name.trim() && (await store.pools?.updateProfile(poolId, { name: name.trim() }))) setOpen(false)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        setOpen(next)
        if (next) setName(current)
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Your name
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader title="Your name in the pool" description="How the other members see you." />
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Name">
            <Input autoFocus value={name} onChange={event => setName(event.target.value)} />
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={!name.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
