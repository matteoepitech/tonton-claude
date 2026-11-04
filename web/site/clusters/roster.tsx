// Who is in the cluster and what each session does, live: every member, its machines and their sessions, with the
// state the relay sees and the status line, project, branch, tool and model the session's agent shares, sealed. Your own
// sessions can be put in or taken out, and each chooses how it takes the posts (docs/cluster.md, The rule).
import { LogInIcon, LogOutIcon } from 'lucide-react'
import { useState } from 'react'
import { type ClusterDelivery, type ClusterSession, type Session, STATUS_LABELS } from '../../../shared'
import { Empty, StatusDot } from '../common'
import { ago, plural } from '../format'
import { useStore } from '../store'
import { Button } from '../ui/button'
import { Badge, Card } from '../ui/card'
import { NativeSelect } from '../ui/select'
import { DELIVERIES, profileOf, rememberDelivery, rememberedDelivery, roster, sessionName, TOOL_LABELS } from './model'
import type { ClusterTabProps } from './page'

export function Roster({ cluster, state }: ClusterTabProps) {
  const store = useStore()
  const members = roster(state, store.account)
  return (
    <div className="flex flex-col gap-4">
      {members.map(member => (
        <Card key={member.account} className="gap-0 p-0">
          <div className="flex items-center gap-2 border-b px-4 py-2.5">
            <strong>{member.name}</strong>
            {member.mine && <Badge variant="secondary">You</Badge>}
            {member.role === 'owner' && <Badge variant="outline">Owner</Badge>}
            <small className="ms-auto text-xs text-muted-foreground">{plural(member.sessions, 'session')}</small>
          </div>
          {!member.machines.length && <Empty className="px-4 py-3">No session in the cluster yet.</Empty>}
          {member.machines.map(machine => (
            <div key={machine.key} className="border-b last:border-b-0">
              <h3 className="eyebrow px-4 pt-2.5">{machine.name}</h3>
              <ul className="flex flex-col divide-y">
                {machine.sessions.map(session => (
                  <SessionRow key={session.session} clusterId={cluster.id} session={session} mine={member.mine} />
                ))}
              </ul>
            </div>
          ))}
        </Card>
      ))}
      <YourSessions clusterId={cluster.id} inCluster={state.sessions.filter(s => s.account === store.account).map(s => s.session)} />
    </div>
  )
}

function SessionRow({ clusterId, session, mine }: { clusterId: string; session: ClusterSession; mine: boolean }) {
  const store = useStore()
  const profile = session.profile
  const facts = [profile?.project, profile?.branch, profile?.tool ? TOOL_LABELS[profile.tool] : undefined, profile?.model].filter(Boolean)
  const own = mine ? store.state?.sessions.find(s => s.id === session.session) : undefined
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
      <StatusDot status={session.online ? session.status : 'offline'} />
      {/* On a phone the actions go under the session rather than squeezing what it says. */}
      <span className="flex min-w-[min(16rem,100%)] flex-1 flex-col">
        <span className="flex items-center gap-2">
          <strong className="truncate font-medium">{sessionName(session)}</strong>
          <small className="text-xs text-muted-foreground">
            {!session.online ? 'Offline' : !session.ready ? 'Waiting for its agent' : session.status ? STATUS_LABELS[session.status] : ''}
          </small>
        </span>
        {profile?.status && (
          <span className="truncate text-sm">
            {profile.status}
            {profile.statusAt && <small className="text-xs text-muted-foreground"> · {ago(profile.statusAt)}</small>}
          </span>
        )}
        {facts.length > 0 && <small className="truncate text-xs text-muted-foreground">{facts.join(' · ')}</small>}
      </span>
      {mine && (
        <span className="flex items-center gap-2">
          {own && <DeliveryPicker clusterId={clusterId} session={own} />}
          <Button variant="ghost" size="sm" onClick={() => store.clusters?.takeSessionOut(clusterId, session.session)}>
            <LogOutIcon />
            Take out
          </Button>
        </span>
      )}
    </li>
  )
}

/** This account's live sessions that are not in the cluster yet: only their owner puts them in. */
function YourSessions({ clusterId, inCluster }: { clusterId: string; inCluster: string[] }) {
  const store = useStore()
  const sessions = (store.state?.sessions ?? []).filter(s => s.agentOnline && s.status !== 'ended' && !inCluster.includes(s.id))
  return (
    <Card className="gap-0 p-0">
      <div className="border-b px-4 py-2.5">
        <strong>Put your sessions in</strong>
        <p className="text-xs text-muted-foreground">
          A session in the cluster tells the others what it does and reads what they post, as information, never as orders. Permission
          prompts stay yours.
        </p>
      </div>
      {!sessions.length && <Empty className="px-4 py-3">None of your running sessions is outside the cluster.</Empty>}
      <ul className="flex flex-col divide-y">
        {sessions.map(session => (
          <li key={session.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
            <StatusDot status={session.status} />
            <span className="flex min-w-0 flex-1 flex-col">
              <strong className="truncate font-medium">{session.name ?? session.title ?? session.project}</strong>
              <small className="truncate text-xs text-muted-foreground">
                {[session.machine, session.project, session.branch].filter(Boolean).join(' · ')}
              </small>
            </span>
            <PutIn clusterId={clusterId} session={session} />
          </li>
        ))}
      </ul>
    </Card>
  )
}

function PutIn({ clusterId, session }: { clusterId: string; session: Session }) {
  const store = useStore()
  const [delivery, setDelivery] = useState<ClusterDelivery>(() => rememberedDelivery(clusterId, session.id))
  return (
    <span className="flex items-center gap-2">
      <DeliverySelect value={delivery} onChange={setDelivery} />
      <Button
        size="sm"
        onClick={() => {
          rememberDelivery(clusterId, session.id, delivery)
          void store.clusters?.putSession(clusterId, session.id, profileOf(session), { delivery })
        }}
      >
        <LogInIcon />
        Put in
      </Button>
    </span>
  )
}

/**
 * The relay keeps each session's order sealed with the account key and sends it only to its agent, so a browser shows
 * the delivery it last chose itself. Changing it sends a new order.
 */
function DeliveryPicker({ clusterId, session }: { clusterId: string; session: Session }) {
  const store = useStore()
  const [delivery, setDelivery] = useState<ClusterDelivery>(() => rememberedDelivery(clusterId, session.id))
  return (
    <DeliverySelect
      value={delivery}
      onChange={next => {
        setDelivery(next)
        rememberDelivery(clusterId, session.id, next)
        void store.clusters?.putSession(clusterId, session.id, profileOf(session), { delivery: next })
      }}
    />
  )
}

function DeliverySelect({ value, onChange }: { value: ClusterDelivery; onChange(value: ClusterDelivery): void }) {
  return (
    <NativeSelect
      aria-label="How it takes the posts"
      title="A session that skips permission prompts gets a digest even when Live is chosen."
      value={value}
      onChange={event => onChange(event.target.value as ClusterDelivery)}
      className="h-8 w-auto"
    >
      {DELIVERIES.map(choice => (
        <option key={choice.value} value={choice.value} title={choice.detail}>
          {choice.label}
        </option>
      ))}
    </NativeSelect>
  )
}
