// A pool's control center, like a network's dashboard: every member, its machines and pool sessions, what each one runs
// on and works on, whether it is online, what it spent and how much of its account's windows is left. Above them, the
// graph (React Flow): every session a node, animated arrows for who writes to whom and for who works on which task.
import { Background, Controls, type Edge, Handle, MarkerType, type Node, type NodeProps, Position, ReactFlow } from '@xyflow/react'
import { useMemo, useState } from 'react'
import {
  type ControlFilter,
  controlCenter,
  filterControl,
  type MemberCard,
  type PoolRole,
  type PoolState,
  type SessionCard,
  type StatusGroup,
  statusCounts,
  TASK_STATE_LABELS,
  talkGraph,
} from '../../../shared'
import { Empty, StatusDot, Toolbar } from '../common'
import { ago, compact } from '../format'
import { useStore } from '../store'
import { Card } from '../ui/card'
import { cn } from '../ui/cn'
import { NativeSelect } from '../ui/select'
import type { TabProps } from './page'
import { ROLES, roleLabel } from './roles'

const GROUP_LABELS: Record<StatusGroup, string> = { working: 'Working', 'needs-you': 'Needs its owner', idle: 'Idle', offline: 'Offline' }
const GROUP_COLORS: Record<StatusGroup, string> = {
  working: 'text-primary',
  'needs-you': 'text-orange',
  idle: 'text-success',
  offline: 'text-muted-foreground',
}

/** The filters, per pool: kept while the pool changes live and while the user goes to another tab. */
const filters = new Map<string, ControlFilter>()

export function ControlCenter({ pool, state }: TabProps) {
  const store = useStore()
  const [filter, setFilter] = useState<ControlFilter>(() => filters.get(pool.id) ?? {})
  const change = (next: ControlFilter) => {
    filters.set(pool.id, next)
    setFilter(next)
  }
  const cards = controlCenter(state)
  const shown = filterControl(cards, filter)
  const counts = statusCounts(cards)
  return (
    <div className="flex flex-col gap-4">
      <Toolbar title="Control center" detail={state.paused ? 'The pool is paused' : 'Live'}>
        <NativeSelect
          aria-label="Role"
          value={filter.role ?? ''}
          onChange={event => change({ ...filter, role: (event.target.value || undefined) as PoolRole | undefined })}
        >
          <option value="">Every role</option>
          {ROLES.map(role => (
            <option key={role} value={role}>
              {roleLabel(role)}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Member"
          value={filter.account ?? ''}
          onChange={event => change({ ...filter, account: event.target.value || undefined })}
        >
          <option value="">Every member</option>
          {cards.map(card => (
            <option key={card.account} value={card.account}>
              {card.name}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Status"
          value={filter.group ?? ''}
          onChange={event => change({ ...filter, group: (event.target.value || undefined) as StatusGroup | undefined })}
        >
          <option value="">Every status</option>
          {(Object.keys(GROUP_LABELS) as StatusGroup[]).map(group => (
            <option key={group} value={group}>
              {GROUP_LABELS[group]}
            </option>
          ))}
        </NativeSelect>
      </Toolbar>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(Object.keys(GROUP_LABELS) as StatusGroup[]).map(group => (
          <Card key={group} className="p-3">
            <div className={cn('text-2xl font-semibold', GROUP_COLORS[group])}>{counts[group]}</div>
            <div className="text-xs text-muted-foreground">{GROUP_LABELS[group]}</div>
          </Card>
        ))}
      </div>
      <Graph state={state} />
      <div className="grid gap-3 lg:grid-cols-2">
        {shown.map(card => (
          <Person key={card.account} card={card} you={card.account === store.account} />
        ))}
      </div>
      {!shown.length && <Empty>{cards.length ? 'Nobody matches these filters.' : 'Nobody in the pool yet.'}</Empty>}
    </div>
  )
}

function Person({ card, you }: { card: MemberCard; you: boolean }) {
  const machines = [...new Set(card.sessions.map(session => session.machine).filter(Boolean))]
  return (
    <Card className="flex flex-col gap-2 p-3">
      <div>
        <strong>
          {card.name}
          {you ? ' (you)' : ''}
        </strong>
        <small className="block text-xs text-muted-foreground">
          {[roleLabel(card.role), machines.join(', ') || null].filter(Boolean).join(' · ')}
        </small>
      </div>
      {card.sessions.length ? (
        card.sessions.map(session => <SessionLine key={session.session} session={session} />)
      ) : (
        <p className="text-xs text-muted-foreground">No session in the pool.</p>
      )}
    </Card>
  )
}

function SessionLine({ session }: { session: SessionCard }) {
  const runsOn = [session.tool === 'opencode' ? 'OpenCode' : 'Claude Code', session.model].filter(Boolean).join(' · ')
  return (
    <div className="flex items-start gap-2.5 rounded-lg bg-secondary/60 p-2">
      <StatusDot status={session.status ?? (session.online ? 'idle' : 'offline')} className="mt-1.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-xs">
        <span>
          <strong className="text-sm font-medium">{session.area ?? 'Session'}</strong>
          {session.orchestrator && <em className="text-primary not-italic"> · orchestrator</em>}
          <span className="text-muted-foreground">
            {' '}
            · {runsOn}
            {session.machine ? ` · ${session.machine}` : ''}
          </span>
        </span>
        <span className="truncate">{session.task ? `${TASK_STATE_LABELS[session.task.state]}: ${session.task.title}` : 'No task'}</span>
        <span className="text-muted-foreground">
          {[GROUP_LABELS[session.group], session.lastActivity ? `last seen ${ago(session.lastActivity)}` : null, usageText(session)]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
    </div>
  )
}

function usageText(session: SessionCard): string | null {
  const usage = session.usage
  const parts: string[] = []
  if (session.costUSD !== null) parts.push(`$${session.costUSD.toFixed(2)}`)
  if (usage?.tokens) parts.push(`${compact(usage.tokens.input + usage.tokens.output)} tokens`)
  if (usage?.fiveHour) parts.push(`${Math.round(usage.fiveHour.usedPercent)}% of 5 h`)
  if (usage?.sevenDay) parts.push(`${Math.round(usage.sevenDay.usedPercent)}% of the week`)
  return parts.join(' · ') || null
}

// MARK: The graph

interface PeerData extends Record<string, unknown> {
  label: string
  detail?: string
  group?: StatusGroup
  kind: 'session' | 'member' | 'area' | 'everyone' | 'task'
}

function PeerNode({ data }: NodeProps<Node<PeerData>>) {
  return (
    <div
      className={cn(
        'max-w-44 rounded-lg border bg-card px-2.5 py-1.5 text-xs shadow-sm',
        data.kind === 'task' && 'border-dashed bg-secondary',
        data.kind === 'everyone' || data.kind === 'area' ? 'rounded-full text-muted-foreground' : '',
      )}
    >
      <Handle type="target" position={Position.Top} className="!size-1.5 !border-0 !bg-transparent" />
      <div className="flex items-center gap-1.5">
        {data.group && <span className={cn('size-2 shrink-0 rounded-full bg-current', GROUP_COLORS[data.group])} />}
        <strong className="truncate font-medium">{data.label}</strong>
      </div>
      {data.detail && <div className="truncate text-[10px] text-muted-foreground">{data.detail}</div>}
      <Handle type="source" position={Position.Bottom} className="!size-1.5 !border-0 !bg-transparent" />
    </div>
  )
}

const nodeTypes = { peer: PeerNode }
/** A pool of one or two sessions is not drawn huge. */
const FIT = { maxZoom: 1, padding: 0.3 }

/** Everyone on a circle, the tasks being worked on just outside their session, arrows for messages and for work. */
function Graph({ state }: { state: PoolState }) {
  const { nodes, edges } = useMemo(() => layout(state), [state])
  if (!nodes.length) return null
  return (
    <Card className="h-[420px] overflow-hidden" aria-label="Who talks to whom, and who works on what">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={FIT}
        minZoom={0.3}
        maxZoom={1.8}
        nodesConnectable={false}
        nodesDraggable={false}
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </Card>
  )
}

function layout(state: PoolState): { nodes: Node<PeerData>[]; edges: Edge[] } {
  const talk = talkGraph(state)
  const cards = controlCenter(state).flatMap(card => card.sessions)
  const card = (id: string) => cards.find(session => `s:${session.account}/${session.session}` === id)
  const radius = Math.max(160, talk.nodes.length * 34)
  const nodes: Node<PeerData>[] = []
  const edges: Edge[] = []
  talk.nodes.forEach((peer, index) => {
    const angle = (2 * Math.PI * index) / Math.max(1, talk.nodes.length) - Math.PI / 2
    const session = card(peer.id)
    nodes.push({
      id: peer.id,
      type: 'peer',
      position: { x: radius * Math.cos(angle), y: radius * Math.sin(angle) },
      data: {
        label: peer.label,
        kind: peer.kind,
        group: session?.group,
        detail: session
          ? [session.tool === 'opencode' ? 'OpenCode' : 'Claude Code', session.machine].filter(Boolean).join(' · ')
          : undefined,
      },
    })
    // Who works on what: the task a session is on, just outside it.
    if (session?.task) {
      const taskId = `t:${session.task.id}`
      if (!nodes.some(node => node.id === taskId))
        nodes.push({
          id: taskId,
          type: 'peer',
          position: { x: (radius + 170) * Math.cos(angle), y: (radius + 170) * Math.sin(angle) },
          data: { label: session.task.title, detail: TASK_STATE_LABELS[session.task.state], kind: 'task' },
        })
      edges.push({
        id: `w:${peer.id}`,
        source: peer.id,
        target: taskId,
        animated: session.group === 'working',
        style: { stroke: 'var(--primary)', strokeDasharray: '4 4' },
      })
    }
  })
  for (const link of talk.edges) {
    edges.push({
      id: `m:${link.from}>${link.to}`,
      source: link.from,
      target: link.to,
      animated: true,
      label: link.count > 1 ? String(link.count) : undefined,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { strokeWidth: 1 + Math.log2(link.count) },
    })
  }
  return { nodes, edges }
}
