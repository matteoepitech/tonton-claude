// From facts about a session's work to the rewards the agent sends. Only facts leave here: shared/rpg.ts turns them into
// XP. Each id depends only on what happened, so the live agent, a restart and the backfill name the same reward.

import { isRPGReward, type RPGReward, rpgReward } from '../../shared/rpg'
import { projectOf } from './channel/conversation'
import type { VcsWork } from './cluster/detect'
import type { TaskFact, TurnFact } from './transcript/work'

/** The welcome backfill reads this far back, and a session read again earns nothing older. */
export const BACKFILL_DAYS = 14
const DAY_MS = 86_400_000
/** A turn that earns nothing (not prompted, under a minute) is not sent at all. */
const MINUTE = 60

/** What one session did, as Claude Code's transcript or OpenCode's events tell it. */
export interface SessionWork {
  turns?: readonly TurnFact[]
  tasks?: readonly TaskFact[]
  vcs?: readonly VcsWork[]
  /** The session's folder: the project a turn is about. */
  cwd?: string
}

/** A turn, and the day's first prompted turn: the day reward has one id a day for the whole account. */
export async function turnRewards(session: string, turn: TurnFact, cwd?: string): Promise<RPGReward[]> {
  if (!turn.prompted && turn.seconds < MINUTE) return []
  const note = cwd ? projectOf(cwd) : undefined
  const extra = { seconds: turn.seconds, prompted: turn.prompted, ...(note ? { note } : {}) }
  const rewards = [await rpgReward('turn', `${session}\n${turn.id}`, turn.at, extra)]
  if (turn.prompted) rewards.push(await rpgReward('day', turn.at.slice(0, 10), turn.at))
  return rewards
}

/** Version 1's identity: the session and the task's text. */
export function checklistRewards(session: string, tasks: readonly TaskFact[]): Promise<RPGReward[]> {
  return Promise.all(tasks.map(task => rpgReward('task', `${session}\n${task.content}`, task.at)))
}

/**
 * One reward per commit a push sent, named by its hash as git printed it: the same commit pushed again, or to another
 * remote, counts once. One per submitted changelist, on the server its command named: what the shell call says and
 * nothing else, so a submit read again weeks later has the same id.
 */
export async function vcsRewards(work: readonly VcsWork[]): Promise<RPGReward[]> {
  const rewards: RPGReward[] = []
  for (const item of work) {
    if (item.kind === 'push') {
      for (const commit of item.commits) rewards.push(await rpgReward('push', `git\n${commit}`, item.ts, { note: item.branch }))
    } else {
      const server = item.port?.toLowerCase() ?? ''
      rewards.push(await rpgReward('push', `p4\n${server}\n${item.change}`, item.ts, { note: `CL ${item.change}` }))
    }
  }
  return rewards
}

/** Everything a session's work earns, back to `since`. `inPool`: a pool session's checklist is the pool's, it earns no solo XP. */
export async function workRewards(
  session: string,
  work: SessionWork,
  inPool: boolean,
  since = Date.now() - BACKFILL_DAYS * DAY_MS,
): Promise<RPGReward[]> {
  const recent = (at: string) => Date.parse(at) >= since
  const turns = (work.turns ?? []).filter(turn => recent(turn.at))
  const tasks = inPool ? [] : (work.tasks ?? []).filter(task => recent(task.at))
  const vcs = (work.vcs ?? []).filter(item => recent(item.ts))
  const rewards = [
    ...(await Promise.all(turns.map(turn => turnRewards(session, turn, work.cwd)))).flat(),
    ...(await checklistRewards(session, tasks)),
    ...(await vcsRewards(vcs)),
  ]
  return rewards.filter(isRPGReward)
}
