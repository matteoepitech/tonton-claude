// What the cluster pages show, worked out from the cluster's state alone: the roster by member and machine, who wrote a
// post, what a post says in a line, and the clock. Shared by the website and the island (web/views.ts), tested in
// web/test/clusters.test.ts.
import type { ClusterPostItem, ClusterSession, ClusterState } from '../../../shared/cluster'
import type {
  ClusterClaim,
  ClusterClock,
  ClusterDelivery,
  ClusterPostKind,
  ClusterRole,
  ClusterSessionProfile,
  ClusterTool,
} from '../../../shared/cluster-protocol'
import { CODING_TOOL_LABELS, codingToolOf, type Session } from '../../../shared/session'

export interface RosterMachine {
  /** The machine's id when the relay attests it, else its name. */
  key: string
  name: string
  sessions: ClusterSession[]
}

export interface RosterMember {
  account: string
  name: string
  role: ClusterRole
  mine: boolean
  machines: RosterMachine[]
  sessions: number
}

export const TOOL_LABELS: Record<ClusterTool, string> = CODING_TOOL_LABELS

export const POST_KINDS: Record<ClusterPostKind, string> = {
  message: 'Message',
  ask: 'Question',
  answer: 'Answer',
  event: 'Event',
  claim: 'Claim',
  file: 'File',
  notice: 'Notice',
}

/** Busy sessions first, so that who is doing what reads at a glance. */
const ORDER = ['permission', 'waiting', 'working', 'starting', 'idle', 'error', 'ended', 'offline'] as const

export function memberName(state: Pick<ClusterState, 'members'>, account: string): string {
  return state.members.find(member => member.account === account)?.profile?.name?.trim() || 'A member'
}

export function sessionName(session: ClusterSession): string {
  const profile = session.profile
  return profile?.name?.trim() || profile?.project?.trim() || 'A session'
}

/** Every member with its sessions by machine: this account first, then the owner, then by name. */
export function roster(state: ClusterState, account: string | null): RosterMember[] {
  const rank = (status: ClusterSession['status']) => (status ? ORDER.indexOf(status) : ORDER.length)
  return state.members
    .map(member => {
      const machines = new Map<string, RosterMachine>()
      const sessions = state.sessions
        .filter(session => session.account === member.account)
        .sort((a, b) => rank(a.status) - rank(b.status) || sessionName(a).localeCompare(sessionName(b)))
      for (const session of sessions) {
        const name = session.profile?.machine?.trim() || 'A machine'
        const key = session.machine ?? name
        const machine = machines.get(key) ?? { key, name, sessions: [] }
        machine.sessions.push(session)
        machines.set(key, machine)
      }
      return {
        account: member.account,
        name: memberName(state, member.account),
        role: member.role,
        mine: member.account === account,
        machines: [...machines.values()].sort((a, b) => a.name.localeCompare(b.name)),
        sessions: sessions.length,
      }
    })
    .sort(
      (a, b) =>
        Number(b.mine) - Number(a.mine) ||
        Number(b.role === 'owner') - Number(a.role === 'owner') ||
        a.name.localeCompare(b.name) ||
        (a.account < b.account ? -1 : 1),
    )
}

/** Who wrote a post, as sessions see it in their envelope: `name · machine · tool`. */
export function authorLabel(
  state: Pick<ClusterState, 'members' | 'sessions'>,
  author: Pick<ClusterPostItem, 'account' | 'session'>,
): string {
  const name = memberName(state, author.account)
  if (!author.session) return name
  const profile = state.sessions.find(s => s.account === author.account && s.session === author.session)?.profile
  return [name, profile?.machine?.trim(), profile?.tool ? TOOL_LABELS[profile.tool] : undefined].filter(Boolean).join(' · ')
}

/** Who a post is for, in a few words; null for everyone. */
export function recipients(state: Pick<ClusterState, 'members' | 'sessions'>, post: ClusterPostItem): string | null {
  const to = post.body?.to
  if (!to?.length) return null
  return to
    .map(target => {
      const session = target.session && state.sessions.find(s => s.account === target.account && s.session === target.session)
      return session ? `${sessionName(session)} (${memberName(state, target.account)})` : memberName(state, target.account)
    })
    .join(', ')
}

/** An event in a line: "push main · 3", "build failed". */
export function eventLine(post: ClusterPostItem): string | null {
  const event = post.body?.event
  if (!event) return null
  return [event.type, event.ref, event.count !== undefined ? String(event.count) : undefined, event.ok === false ? 'failed' : undefined]
    .filter(Boolean)
    .join(' · ')
}

/** The claims still held, newest first; lapsed ones are left out. */
export function heldClaims(claims: readonly ClusterClaim[], now = Date.now()): ClusterClaim[] {
  return claims.filter(claim => !claim.until || Date.parse(claim.until) > now).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}

export interface ClockMark {
  name: string
  at: string
  passed: boolean
}

export interface ClockView {
  /** Milliseconds to the deadline, 0 once it passed; null without a deadline. */
  left: number | null
  label: string | null
  ended: boolean
  /** The last hour: the notch and the island show the clock even when folded. */
  lastHour: boolean
  marks: ClockMark[]
  next: ClockMark | null
}

/** The clock at `now`: what is left, and the milestones in order. */
export function clockView(clock: ClusterClock | null, now = Date.now()): ClockView {
  const end = clock?.deadline ? Date.parse(clock.deadline) : Number.NaN
  const left = Number.isNaN(end) ? null : Math.max(0, end - now)
  const marks = (clock?.milestones ?? [])
    .filter(mark => !Number.isNaN(Date.parse(mark.at)))
    .map(mark => ({ name: mark.name, at: mark.at, passed: Date.parse(mark.at) <= now }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  return {
    left,
    label: left === null ? null : timeLeft(left),
    ended: left === 0,
    lastHour: left !== null && left > 0 && left <= 3_600_000,
    marks,
    next: marks.find(mark => !mark.passed) ?? null,
  }
}

export function timeLeft(ms: number): string {
  if (ms <= 0) return 'Time is up'
  if (ms < 60_000) return 'Under a minute left'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} min left`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 24) return rest ? `${hours} h ${String(rest).padStart(2, '0')} min left` : `${hours} h left`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return `${days} day${days === 1 ? '' : 's'}${restHours ? ` ${restHours} h` : ''} left`
}

export const DELIVERIES: { value: ClusterDelivery; label: string; detail: string }[] = [
  { value: 'live', label: 'Live', detail: 'Posts reach it as they come' },
  { value: 'digest', label: 'Digest', detail: 'Gathered for its next prompt' },
  { value: 'muted', label: 'Muted', detail: 'Nothing reaches it' },
]

const DELIVERY_KEY = 'tonton.clusterDelivery'

/** What the cluster sees of one of this account's sessions: names and labels, never a full path. */
export function profileOf(session: Session): ClusterSessionProfile {
  const tool: ClusterTool = codingToolOf(session.tool)
  return Object.fromEntries(
    Object.entries({
      name: session.name ?? session.title ?? undefined,
      project: session.project || undefined,
      machine: session.machine || undefined,
      tool,
      model: session.model ?? undefined,
      branch: session.branch ?? undefined,
    }).filter(([, value]) => value !== undefined),
  ) as ClusterSessionProfile
}

export function rememberedDelivery(clusterId: string, sessionId: string): ClusterDelivery {
  try {
    const saved = JSON.parse(localStorage.getItem(DELIVERY_KEY) ?? '{}')[`${clusterId}/${sessionId}`]
    return DELIVERIES.some(choice => choice.value === saved) ? saved : 'live'
  } catch {
    return 'live'
  }
}

export function rememberDelivery(clusterId: string, sessionId: string, delivery: ClusterDelivery) {
  try {
    const saved = JSON.parse(localStorage.getItem(DELIVERY_KEY) ?? '{}')
    localStorage.setItem(DELIVERY_KEY, JSON.stringify({ ...saved, [`${clusterId}/${sessionId}`]: delivery }))
  } catch {}
}
