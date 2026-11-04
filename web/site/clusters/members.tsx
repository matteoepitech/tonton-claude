// The members of the cluster and the invites. The owner kicks a member, which gives the cluster a new key and revokes
// every open invite, and sees the invites still open. Every member sets the name the others see.
import { LogOutIcon, Trash2Icon, UserMinusIcon } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import type { ClusterInviteSummary } from '../../../shared'
import { Problem } from '../common'
import { plural } from '../format'
import { useStore } from '../store'
import { Button } from '../ui/button'
import { Badge } from '../ui/card'
import { Confirm } from '../ui/dialog'
import { Field, Input } from '../ui/fields'
import { memberName } from './model'
import type { ClusterTabProps } from './page'

export function Members({ cluster, state }: ClusterTabProps) {
  const store = useStore()
  const owner = cluster.role === 'owner'
  const [kicking, setKicking] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [skipped, setSkipped] = useState<string[]>([])
  const members = [...state.members].sort((a, b) => Number(b.role === 'owner') - Number(a.role === 'owner'))
  const kick = async (account: string) => {
    const left = await store.clusters?.kick(cluster.id, account)
    if (left) setSkipped(left)
  }
  const leave = async () => {
    const done = owner ? await store.clusters?.remove(cluster.id) : await store.clusters?.leave(cluster.id)
    if (done) store.showCluster(null)
  }
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <ul className="flex flex-col divide-y rounded-lg border bg-white">
        {members.map(member => (
          <li key={member.account} className="flex items-center gap-3 px-4 py-2.5">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-2">
                <strong className="truncate font-medium">{memberName(state, member.account)}</strong>
                {member.account === store.account && <Badge variant="secondary">You</Badge>}
                {member.role === 'owner' && <Badge variant="outline">Owner</Badge>}
              </span>
              <small className="text-xs text-muted-foreground">
                Joined {new Date(member.joinedAt).toLocaleDateString()} ·{' '}
                {plural(state.sessions.filter(s => s.account === member.account).length, 'session')}
              </small>
            </span>
            {owner && member.account !== store.account && (
              <Button variant="ghost" size="sm" onClick={() => setKicking(member.account)}>
                <UserMinusIcon />
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
      {skipped.length > 0 && (
        <Problem onDismiss={() => setSkipped([])}>
          The new key could not be wrapped for {skipped.map(account => memberName(state, account)).join(', ')}: send them a new invite.
        </Problem>
      )}
      <YourName clusterId={cluster.id} current={state.members.find(m => m.account === store.account)?.profile?.name ?? ''} />
      {/* A removal gives the cluster a new key and revokes the open invites: the list is read again with each key. */}
      {owner && <OpenInvites key={state.keyVersion} clusterId={cluster.id} />}
      <div>
        <Button variant="outline" size="sm" onClick={() => setLeaving(true)}>
          {owner ? <Trash2Icon /> : <LogOutIcon />}
          {owner ? 'Delete the cluster' : 'Leave the cluster'}
        </Button>
      </div>
      <Confirm
        open={kicking !== null}
        onOpenChange={next => !next && setKicking(null)}
        title={`Remove ${kicking ? memberName(state, kicking) : ''}?`}
        description="Their sessions leave the cluster, it gets a new key they never receive, and every open invite is revoked."
        action="Remove"
        onConfirm={() => kicking && void kick(kicking)}
      />
      <Confirm
        open={leaving}
        onOpenChange={setLeaving}
        title={owner ? 'Delete the cluster?' : 'Leave the cluster?'}
        description={
          owner
            ? 'For everyone: its posts, notes, claims and clock go, and every session leaves it. This cannot be undone.'
            : 'Your sessions leave it with you. You need a new invite to come back.'
        }
        action={owner ? 'Delete' : 'Leave'}
        onConfirm={() => void leave()}
      />
    </div>
  )
}

function YourName({ clusterId, current }: { clusterId: string; current: string }) {
  const watch = useStore().clusters
  const [name, setName] = useState(current)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (name.trim()) void watch?.updateProfile(clusterId, { name: name.trim().slice(0, 80) })
  }
  return (
    <form onSubmit={submit} className="flex items-end gap-2">
      <Field label="Your name in the cluster" className="flex-1">
        <Input value={name} onChange={event => setName(event.target.value)} placeholder="How the others see you" />
      </Field>
      <Button type="submit" variant="outline" disabled={!name.trim() || name.trim() === current}>
        Save
      </Button>
    </form>
  )
}

function OpenInvites({ clusterId }: { clusterId: string }) {
  const watch = useStore().clusters
  const [invites, setInvites] = useState<ClusterInviteSummary[] | null>(null)
  const reload = useCallback(() => {
    void watch?.invites(clusterId).then(found => setInvites(found ?? []))
  }, [watch, clusterId])
  useEffect(reload, [reload])
  if (!invites?.length) return null
  return (
    <details className="rounded-lg border bg-white">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{plural(invites.length, 'open invite')}</summary>
      <div className="flex flex-col divide-y border-t">
        {invites.map(invite => (
          <div key={invite.id} className="flex items-center gap-2 px-3 py-2">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm">{plural(invite.usesLeft, 'use')} left</span>
              <small className="text-xs text-muted-foreground">Until {new Date(invite.expiresAt).toLocaleString()}</small>
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                if (await watch?.revokeInvite(clusterId, invite.id)) reload()
              }}
            >
              Revoke
            </Button>
          </div>
        ))}
      </div>
    </details>
  )
}
