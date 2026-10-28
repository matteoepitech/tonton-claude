// Hackathon mode (docs/pools.md): a pool against a deadline. The template puts the deadline and the repository in the
// pool's info and the usual roles in the notes' areas; the countdown shows on the website and in the notch; the
// orchestrator's agent tells it how much time is left at half time, one hour and fifteen minutes before the end.
// Mirrors app/Sources/TontonCore/PoolHackathon.swift; both check shared/test/pool-countdown.json.

import type { PoolInfo, PoolNotes } from './pool-protocol'

/** The roles a hackathon pool starts with, as notes' areas. */
export const HACKATHON_ROLES = ['front', 'back', 'infra', 'qa'] as const

export function hackathonRoleLabel(role: string): string {
  return role === 'qa' ? 'QA' : role
}

export interface HackathonSetup {
  /** ISO date and time. */
  deadline: string
  repo?: string
  roles: readonly string[]
}

/** The pool's info for a hackathon: the template, its deadline and repository, and when the countdown starts. */
export function hackathonInfo(info: PoolInfo, setup: HackathonSetup, now = new Date()): PoolInfo {
  const repo = setup.repo?.trim()
  return { ...info, template: 'hackathon', deadline: setup.deadline, startedAt: now.toISOString(), ...(repo ? { repo } : {}) }
}

/** The notes a hackathon pool starts with: one area per role, for the orchestrator to give paths to. */
export function hackathonNotes(setup: HackathonSetup): PoolNotes {
  const repo = setup.repo?.trim()
  const roles = [...new Set(setup.roles.map(role => role.trim().toLowerCase()).filter(Boolean))]
  return {
    text: '',
    sections: {
      decisions: `A hackathon: the work must be done by ${setup.deadline}${repo ? `, in ${repo}` : ''}. Keep main demo-ready at all times.`,
    },
    areas: roles.map(name => ({ name, paths: [] })),
  }
}

export interface Countdown {
  /** Milliseconds left, 0 once the deadline passed. */
  left: number
  ended: boolean
  /** `2 h 05 min left`, `14 min left`, `Time is up`. */
  label: string
}

/** How long until the deadline, as the website and the notch show it. Null without a deadline that reads. */
export function countdown(deadline: string | undefined, now = Date.now()): Countdown | null {
  const end = deadline ? Date.parse(deadline) : Number.NaN
  if (Number.isNaN(end)) return null
  const left = Math.max(0, end - now)
  return { left, ended: left === 0, label: countdownLabel(left) }
}

export function countdownLabel(ms: number): string {
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

export type TimeMark = 'half' | 'hour' | 'quarter'

/** When each notice to the orchestrator is due: half time, one hour and fifteen minutes before the end. */
export function timeMarks(info: PoolInfo | null, createdAt: string): { mark: TimeMark; at: number }[] {
  const end = info?.deadline ? Date.parse(info.deadline) : Number.NaN
  const start = Date.parse(info?.startedAt ?? createdAt)
  if (Number.isNaN(end) || Number.isNaN(start) || end <= start) return []
  const marks: { mark: TimeMark; at: number }[] = [
    { mark: 'half', at: start + (end - start) / 2 },
    { mark: 'hour', at: end - 3_600_000 },
    { mark: 'quarter', at: end - 900_000 },
  ]
  return marks.filter(({ at }) => at > start && at < end).sort((a, b) => a.at - b.at)
}

/** What the orchestrator is told at each mark. */
export function timeNotice(mark: TimeMark, left: number): string {
  const label = countdownLabel(left)
  switch (mark) {
    case 'half':
      return `Half the time is gone: ${label}. Check the plan against the time left: cut what will not make it, and keep main demo-ready.`
    case 'hour':
      return `${label}. Start no new feature: finish, review and merge what is close, and make main demo-ready.`
    case 'quarter':
      return `${label}: freeze main. Only fixes the demo needs now, then the final checklist.`
  }
}

/** The task the orchestrator's agent adds near the deadline. */
export const FINAL_CHECKLIST = {
  title: 'Final checklist',
  goal: 'Get main ready for the demo before the deadline: the build passes on main, a demo script, and a README that says what it is and how to run it.',
  criteria: [
    'The build passes on main, and the app starts from a fresh clone',
    'A demo script: what to show, in order, in under three minutes',
    'The README says what it is, how to run it, and who built which part',
  ],
} as const
