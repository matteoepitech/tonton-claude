// A pool's control center, like a network's dashboard: every member, its machines and pool sessions, what each one runs
// on and works on, whether it is online, what it spent and how much of its account's windows is left. Above them, the
// graph (React Flow): the pool in the middle, its machines around it, their sessions and the tasks they work on, with
// animated arrows for who writes to whom.
import { Background, Controls, type Edge, Handle, MarkerType, type Node, type NodeProps, Position, ReactFlow } from '@xyflow/react'
import { BotIcon, CpuIcon, NetworkIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  type ControlFilter,
  controlCenter,
  filterControl,
  type MemberCard,
  machinePlanLabel,
  memberName,
  type PoolRole,
  type PoolState,
  type SessionCard,
  type StatusGroup,
  statusCounts,
  TASK_STATE_LABELS,
  talkGraph,
} from '../../../shared'
import { Empty, StatusDot, Toolbar } from '../common'
import { ago, compact, plural } from '../format'
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
  kind: 'hub' | 'machine' | 'session' | 'member' | 'area' | 'everyone' | 'task'
  /** The machine runs the orchestrator. */
  leads?: boolean
}

function PeerNode({ data }: NodeProps<Node<PeerData>>) {
  const hidden = '!size-1.5 !border-0 !bg-transparent'
  return (
    <div
      className={cn(
        'raised flex max-w-52 items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-xs',
        data.kind === 'hub' && 'border-primary/50 px-3 py-2',
        data.kind === 'task' && 'border-dashed shadow-none',
        (data.kind === 'everyone' || data.kind === 'area') && 'rounded-full text-muted-foreground shadow-none',
      )}
    >
      <Handle type="target" position={Position.Top} className={hidden} />
      {data.kind === 'hub' && (
        <span className="icon-tile size-7">
          <NetworkIcon className="size-4" />
        </span>
      )}
      {data.kind === 'machine' && (
        <span className={cn('size-6', data.leads ? 'icon-tile' : 'icon-tile-ink')}>
          {data.leads ? <BotIcon className="size-3.5" /> : <CpuIcon className="size-3.5" />}
        </span>
      )}
      {data.kind === 'member' && (
        <span className="icon-tile size-6 text-[11px] font-bold">{data.label.trim().charAt(0).toUpperCase()}</span>
      )}
      <span className="flex min-w-0 flex-col">
        <span className="flex items-center gap-1.5">
          {data.group && <span className={cn('size-2 shrink-0 rounded-full bg-current', GROUP_COLORS[data.group])} />}
          <strong className={cn('truncate font-medium', data.kind === 'hub' && 'text-sm font-semibold')}>{data.label}</strong>
        </span>
        {data.detail && <span className="truncate text-[10px] text-muted-foreground">{data.detail}</span>}
      </span>
      <Handle type="source" position={Position.Bottom} className={hidden} />
    </div>
  )
}

const nodeTypes = { peer: PeerNode }
const FIT = { maxZoom: 1, padding: 0.2 }
/** Straight lines from the middle out, as a network map draws its links. */
const STRAIGHT = { type: 'straight' } as const

/**
 * The pool as a network: the pool in the middle, its machines around it (and the members without one), each machine's
 * sessions further out, and the task each session works on at the edge. Animated arrows for who writes to whom.
 */
function Graph({ state }: { state: PoolState }) {
  const { nodes, edges } = useMemo(() => layout(state), [state])
  return (
    <Card className="h-[480px] overflow-hidden" aria-label="The pool's machines, sessions and tasks, and who writes to whom">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={STRAIGHT}
        fitView
        fitViewOptions={FIT}
        minZoom={0.3}
        maxZoom={1.8}
        nodesConnectable={false}
        nodesDraggable={false}
      >
        <Background gap={18} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </Card>
  )
}

const at = (radius: number, angle: number) => ({ x: radius * Math.cos(angle) - 80, y: radius * Math.sin(angle) - 20 })

function layout(state: PoolState): { nodes: Node<PeerData>[]; edges: Edge[] } {
  const talk = talkGraph(state)
  const cards = controlCenter(state).flatMap(card => card.sessions)
  const nodes: Node<PeerData>[] = []
  const edges: Edge[] = []
  const machines = state.machines ?? []
  const busy = (machine: string) =>
    state.tasks.filter(item => item.task?.machine?.machine === machine && ['assigned', 'in_progress', 'blocked'].includes(item.task.state))
      .length
  nodes.push({
    id: 'hub',
    type: 'peer',
    position: { x: -90, y: -24 },
    data: {
      label: state.info?.name ?? 'The pool',
      detail: `${plural(machines.length, 'machine')} · ${plural(state.members.length, 'member')}`,
      kind: 'hub',
    },
  })
  // Around the pool: its machines, and the members who have none.
  const anchors = [
    ...machines.map(machine => ({ id: `mc:${machine.machine}`, account: machine.account, machine })),
    ...state.members
      .filter(member => !machines.some(machine => machine.account === member.account))
      .map(member => ({ id: `m:${member.account}`, account: member.account, machine: undefined })),
  ]
  const inner = Math.max(170, anchors.length * 60)
  const outer = inner + 180
  const angles = new Map<string, number>()
  anchors.forEach((anchor, index) => {
    const angle = (2 * Math.PI * index) / Math.max(1, anchors.length) - Math.PI / 2
    angles.set(anchor.id, angle)
    const machine = anchor.machine
    const online = machine ? machine.online && !machine.stopped : true
    nodes.push({
      id: anchor.id,
      type: 'peer',
      position: at(inner, angle),
      data: machine
        ? {
            label: machine.profile?.name ?? 'A machine',
            detail: `${memberName(state, machine.account)} · ${machinePlanLabel(machine.profile)} · ${busy(machine.machine)}/${machine.profile?.capacity ?? 0}`,
            group: !online ? 'offline' : busy(machine.machine) ? 'working' : 'idle',
            kind: 'machine',
            leads: state.orchestratorMachine?.machine === machine.machine,
          }
        : { label: memberName(state, anchor.account), detail: 'No machine in the pool yet', kind: 'member' },
    })
    edges.push({
      id: `h:${anchor.id}`,
      source: 'hub',
      target: anchor.id,
      style: online ? { stroke: 'var(--primary)', strokeWidth: 1.5 } : { stroke: 'var(--faint)', strokeDasharray: '4 4' },
    })
  })
  // Each session next to its machine (or its member), a little apart from the others there, its task beyond it.
  const placed = new Set(nodes.map(node => node.id))
  const around = new Map<string, number>()
  for (const session of state.sessions) {
    const id = `s:${session.account}/${session.session}`
    const anchor = session.machine && angles.has(`mc:${session.machine}`) ? `mc:${session.machine}` : `m:${session.account}`
    const base = angles.get(anchor) ?? 0
    const index = around.get(anchor) ?? 0
    around.set(anchor, index + 1)
    const angle = base + (index % 2 ? 1 : -1) * Math.ceil(index / 2) * 0.32
    const card = cards.find(c => c.account === session.account && c.session === session.session)
    nodes.push({
      id,
      type: 'peer',
      position: at(outer, angle),
      data: {
        label: talk.nodes.find(node => node.id === id)?.label ?? card?.name ?? 'A session',
        detail: card ? (card.tool === 'opencode' ? 'OpenCode' : 'Claude Code') : undefined,
        group: card?.group,
        kind: 'session',
      },
    })
    placed.add(id)
    if (placed.has(anchor)) edges.push({ id: `a:${id}`, source: anchor, target: id, style: { stroke: 'var(--border)', strokeWidth: 1.5 } })
    if (card?.task) {
      const taskId = `t:${card.task.id}`
      if (!placed.has(taskId)) {
        nodes.push({
          id: taskId,
          type: 'peer',
          position: at(outer + 190, angle),
          data: { label: card.task.title, detail: TASK_STATE_LABELS[card.task.state], kind: 'task' },
        })
        placed.add(taskId)
      }
      edges.push({
        id: `w:${id}`,
        source: id,
        target: taskId,
        animated: card.group === 'working',
        style: { stroke: 'var(--primary)', strokeDasharray: '4 4' },
      })
    }
  }
  // Who writes to whom: the areas and everyone, on the outside, and the arrows.
  const others = talk.nodes.filter(node => !placed.has(node.id))
  others.forEach((node, index) => {
    nodes.push({
      id: node.id,
      type: 'peer',
      position: at(outer + 400, (2 * Math.PI * index) / Math.max(1, others.length) + Math.PI / 4),
      data: { label: node.label, kind: node.kind },
    })
  })
  for (const link of talk.edges) {
    edges.push({
      id: `msg:${link.from}>${link.to}`,
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
