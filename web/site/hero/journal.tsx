// The journal: the last gains with why they came, newest first, the time on the right (the date for older days).
import { type RPGState, rpgJournal } from '../../../shared'
import { journalReason, journalTime, number } from '../../hero'
import { Empty } from '../common'

const SHOWN = 20

export function Journal({ hero, now }: { hero: RPGState; now: number }) {
  const entries = rpgJournal(hero, SHOWN)
  if (!entries.length) return <Empty className="py-3">Finish a turn in Claude Code or OpenCode: Tonton earns XP for the work.</Empty>
  return (
    <section aria-label="Journal">
      <ol className="divide-y divide-dashed rounded-lg border bg-white px-3 text-sm">
        {entries.map(entry => (
          <li key={entry.id} className="flex items-baseline gap-3 py-2">
            <span className="min-w-0 flex-1 truncate">
              <strong className="tabular-nums text-primary">+{number(entry.xp)}</strong> · {journalReason(entry)}
            </span>
            <time className="shrink-0 text-xs tabular-nums text-muted-foreground" dateTime={entry.at ?? entry.day}>
              {journalTime(entry, new Date(now))}
            </time>
          </li>
        ))}
      </ol>
    </section>
  )
}
