// Who is in the pool: members with their roles (changed, handed over, removed by those who may), each with its machines,
// and the sessions put in by hand, with the choice of the orchestrator.
import { CrownIcon, UserRoundXIcon } from 'lucide-react'
import { type FormEvent, type ReactNode, useState } from 'react'
import {
  assignableRoles,
  canKick,
  hackathonRoleLabel,
  memberName,
  type PoolRole,
  type PoolSession,
  type PoolState,
  poolAbilities,
  sessionName,
  sortedMembers,
} from '../../../shared'
import { Empty, Problem } from '../common'
import { plural } from '../format'
import { useStore } from '../store'
import { Button } from '../ui/button'
import { Badge } from '../ui/card'
import { Confirm, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTrigger } from '../ui/dialog'
import { Field, Input } from '../ui/fields'
import { NativeSelect } from '../ui/select'
import type { TabProps } from './page'
import { roleLabel } from './roles'

/**
 * Who is in the pool, each member with what the viewer may change of them: its role, the pool handed over, removed. Each
 * one's machines come under it (`machines`), the sessions put in by hand after them.
 */
export function Members({ pool, state, machines }: TabProps & { machines: (account: string) => ReactNode }) {
  const store = useStore()
  const watch = store.pools
  const choose = poolAbilities(pool.role).chooseOrchestrator
  const [skipped, setSkipped] = useState<number | null>(null)
  const byHand = state.sessions.filter(session => !session.machine)
  return (
    <div className="flex flex-col gap-4">
      {skipped ? (
        <Problem onDismiss={() => setSkipped(null)}>{plural(skipped, 'member')} could not get the new key: send them a new invite.</Problem>
      ) : null}
      {sortedMembers(state).map(member => {
        const self = member.account === store.account
        const name = memberName(state, member.account)
        const roles = assignableRoles(pool.role, member.role, self)
        return (
          <section key={member.account} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="font-medium">
                {name}
                {self ? ' (you)' : ''}
              </strong>
              {roles.length ? (
                <NativeSelect
                  aria-label={`Role of ${name}`}
                  className="h-7 text-xs"
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
              <span className="ms-auto flex gap-1">
                {pool.role === 'owner' && !self && (
                  <Confirm
                    trigger={
                      <Button variant="ghost" size="sm" title="Make owner">
                        <CrownIcon />
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
                      <Button variant="ghost" size="sm" className="text-destructive" title="Remove from the pool">
                        <UserRoundXIcon />
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
              </span>
            </div>
            {machines(member.account)}
          </section>
        )
      })}
      {byHand.length > 0 && <Sessions poolId={pool.id} state={state} sessions={byHand} choose={choose} />}
    </div>
  )
}

/** Sessions their owners put in the pool from the notch, one by one, rather than with a whole machine. */
function Sessions({ poolId, state, sessions, choose }: { poolId: string; state: PoolState; sessions: PoolSession[]; choose: boolean }) {
  const watch = useStore().pools
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Sessions put in by hand</h3>
      {sessions.length ? (
        <div className="flex flex-col divide-y rounded-lg border">
          {sessions.map(session => {
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

export function NameDialog({ poolId, current }: { poolId: string; current: string }) {
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
