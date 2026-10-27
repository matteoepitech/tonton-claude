// A pool's control center, like a network's dashboard: every member, its machines and pool sessions, what each one
// runs on and works on, whether it is online, what it spent and how much of its account's windows is left, and a graph
// of who talks to whom. Live: it is drawn again with every change of the pool. Everything goes in as text or SVG nodes.

import {
  controlCenter,
  filterControl,
  type MemberCard,
  type OpenPool,
  type PoolRole,
  type PoolState,
  type SessionCard,
  type StatusGroup,
  statusCounts,
  TASK_STATE_LABELS,
  talkGraph,
} from '../shared'
import { element } from './markdown'
import type { PageControls, PoolsContext } from './pools'

const GROUP_LABELS: Record<StatusGroup, string> = { working: 'Working', 'needs-you': 'Needs its owner', idle: 'Idle', offline: 'Offline' }
const ROLE_LABELS: Record<PoolRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' }

/** The filters, per pool: kept while the pool changes live. */
const filters = new Map<string, { role?: PoolRole; account?: string; group?: StatusGroup; bar?: HTMLElement; members?: string }>()

export function renderControl(body: HTMLElement, pool: OpenPool, state: PoolState, context: PoolsContext, page: PageControls) {
  const filter = filters.get(pool.id) ?? {}
  filters.set(pool.id, filter)
  const cards = controlCenter(state)
  // Made again when someone joins or leaves, so the member filter lists them.
  const members = cards.map(card => card.account).join()
  if (!filter.bar?.isConnected || filter.members !== members) {
    filter.members = members
    filter.bar = filterBar(pool.id, cards, context)
    page.openPanel(filter.bar)
  }
  const shown = filterControl(cards, filter)
  const counts = statusCounts(cards)
  const summary = element(
    'div',
    ...(Object.keys(GROUP_LABELS) as StatusGroup[]).map(group => {
      const tile = element('div', element('strong', String(counts[group])), element('small', GROUP_LABELS[group]))
      tile.className = `tile ${group}`
      return tile
    }),
  )
  summary.className = 'tiles'
  const people = element('div', ...shown.map(card => memberCard(card, context.account)))
  people.className = 'people'
  if (!shown.length) people.append(element('p', cards.length ? 'Nobody matches these filters.' : 'Nobody in the pool yet.'))
  body.replaceChildren(
    element('div', element('h2', 'Control center'), element('small', state.paused ? 'The pool is paused' : 'Live')),
    summary,
    people,
    element('h2', 'Who talks to whom'),
    talkView(state),
  )
  body.firstElementChild?.classList.add('pool-toolbar')
}

function filterBar(poolId: string, cards: MemberCard[], context: PoolsContext): HTMLElement {
  const filter = filters.get(poolId) ?? {}
  const select = (label: string, options: [string, string][], value: string | undefined, set: (value: string) => void) => {
    const node = element('select')
    node.setAttribute('aria-label', label)
    for (const [id, text] of [['', `Every ${label.toLowerCase()}`] as [string, string], ...options]) {
      const option = element('option', text)
      option.value = id
      option.selected = id === (value ?? '')
      node.append(option)
    }
    node.onchange = () => {
      set(node.value)
      context.rerender()
    }
    return node
  }
  const bar = element(
    'div',
    select(
      'Role',
      (Object.keys(ROLE_LABELS) as PoolRole[]).map(role => [role, ROLE_LABELS[role]]),
      filter.role,
      value => {
        filter.role = (value || undefined) as PoolRole | undefined
      },
    ),
    select(
      'Member',
      cards.map(card => [card.account, card.name]),
      filter.account,
      value => {
        filter.account = value || undefined
      },
    ),
    select(
      'Status',
      (Object.keys(GROUP_LABELS) as StatusGroup[]).map(group => [group, GROUP_LABELS[group]]),
      filter.group,
      value => {
        filter.group = (value || undefined) as StatusGroup | undefined
      },
    ),
  )
  bar.className = 'filters'
  return bar
}

function memberCard(card: MemberCard, account: string): HTMLElement {
  const machines = [...new Set(card.sessions.map(session => session.machine).filter((machine): machine is string => Boolean(machine)))]
  const head = element(
    'div',
    element('strong', card.name + (card.account === account ? ' (you)' : '')),
    element('small', [ROLE_LABELS[card.role], machines.length ? machines.join(', ') : null].filter(Boolean).join(' · ')),
  )
  head.className = 'person-head'
  const sessions = card.sessions.map(sessionRow)
  const node = element('section', head, ...(sessions.length ? sessions : [element('p', 'No session in the pool.')]))
  node.className = 'person'
  return node
}

function sessionRow(session: SessionCard): HTMLElement {
  const dot = element('i')
  dot.className = `dot ${session.status ?? (session.online ? 'idle' : 'offline')}`
  dot.title = GROUP_LABELS[session.group]
  const name = element('strong', session.area ? `${session.area}` : 'Session')
  if (session.orchestrator) name.append(element('em', ' · orchestrator'))
  const runsOn = [session.tool === 'opencode' ? 'OpenCode' : 'Claude Code', session.model].filter(Boolean).join(' · ')
  const lines: HTMLElement[] = [
    element('span', name, element('small', `${runsOn}${session.machine ? ` · ${session.machine}` : ''}`)),
    element(
      'span',
      element('small', session.task ? `${TASK_STATE_LABELS[session.task.state]}: ${session.task.title}` : 'No task'),
      element(
        'small',
        [GROUP_LABELS[session.group], session.lastActivity ? `last seen ${ago(session.lastActivity)}` : null].filter(Boolean).join(' · '),
      ),
    ),
  ]
  const usage = usageText(session)
  if (usage) lines.push(element('span', element('small', usage)))
  const row = element('div', dot, ...lines)
  row.className = `pool-session ${session.group}`
  return row
}

function usageText(session: SessionCard): string | null {
  const usage = session.usage
  if (!usage) return null
  const parts: string[] = []
  if (usage.costUSD !== undefined) parts.push(`$${usage.costUSD.toFixed(2)}`)
  if (usage.tokens) parts.push(`${compact(usage.tokens.input + usage.tokens.output)} tokens`)
  if (usage.fiveHour) parts.push(`${Math.round(usage.fiveHour.usedPercent)}% of 5 h`)
  if (usage.sevenDay) parts.push(`${Math.round(usage.sevenDay.usedPercent)}% of the week`)
  return parts.join(' · ') || null
}

// MARK: The graph

const SVG = 'http://www.w3.org/2000/svg'

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>, ...children: (Node | string)[]) {
  const node = document.createElementNS(SVG, tag)
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value))
  node.append(...children)
  return node
}

/** Everyone on a circle, a line from each writer to whom it wrote, thicker with more messages. */
function talkView(state: PoolState): HTMLElement | SVGSVGElement {
  const { nodes, edges } = talkGraph(state)
  if (!edges.length) return element('p', 'No messages yet.')
  const size = 360
  const center = size / 2
  const radius = size / 2 - 70
  const place = new Map(
    nodes.map((node, index) => {
      const angle = (2 * Math.PI * index) / nodes.length - Math.PI / 2
      return [node.id, { x: center + radius * Math.cos(angle), y: center + radius * Math.sin(angle), angle }]
    }),
  )
  const graph = svg('svg', { viewBox: `0 0 ${size} ${size}`, role: 'img', class: 'talk' })
  graph.append(svg('title', {}, `Who talks to whom: ${edges.length} pair${edges.length === 1 ? '' : 's'}`))
  graph.append(
    svg(
      'defs',
      {},
      svg(
        'marker',
        { id: 'talk-arrow', viewBox: '0 0 10 10', refX: 16, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto' },
        svg('path', { d: 'M0,0 L10,5 L0,10 z', class: 'talk-arrow' }),
      ),
    ),
  )
  for (const edge of edges) {
    const from = place.get(edge.from)
    const to = place.get(edge.to)
    if (!from || !to) continue
    const line = svg('line', {
      x1: from.x.toFixed(1),
      y1: from.y.toFixed(1),
      x2: to.x.toFixed(1),
      y2: to.y.toFixed(1),
      class: 'talk-edge',
      'stroke-width': (1 + Math.log2(edge.count)).toFixed(2),
      'marker-end': 'url(#talk-arrow)',
    })
    line.append(svg('title', {}, `${edge.count} message${edge.count === 1 ? '' : 's'}`))
    graph.append(line)
  }
  for (const node of nodes) {
    const at = place.get(node.id)
    if (!at) continue
    const outside = Math.cos(at.angle) >= 0
    graph.append(
      svg('circle', { cx: at.x.toFixed(1), cy: at.y.toFixed(1), r: 7, class: `talk-node ${node.kind}` }, svg('title', {}, node.label)),
      svg(
        'text',
        {
          x: (at.x + (outside ? 11 : -11)).toFixed(1),
          y: (at.y + 4).toFixed(1),
          'text-anchor': outside ? 'start' : 'end',
          class: 'talk-label',
        },
        node.label,
      ),
    )
  }
  const legend = element('small', 'Lines go from who wrote to whom it was for; thicker means more messages.')
  const wrap = element('div', legend)
  wrap.prepend(graph as unknown as Node)
  wrap.className = 'talk-wrap'
  return wrap
}

// MARK: Formatting

export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`
  return new Date(iso).toLocaleDateString()
}

export function compact(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1000) return `${Math.round(count / 1000)}k`
  return String(count)
}

export function duration(seconds: number): string {
  if (seconds < 60) return seconds ? `${Math.round(seconds)} s` : '—'
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`
}
