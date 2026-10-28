// A pool's activity: everything that happened, newest first (joins, tasks created and moved, messages, blockers, merges,
// key changes and the other audit events), with a search, filters by member, session and kind, and an export as JSON or
// Markdown made in the page.
import { CopyIcon, DownloadIcon } from 'lucide-react'
import { useState } from 'react'
import { filterTimeline, sessionName, type TimelineFilter, timeline, timelineJson, timelineMarkdown } from '../../../shared'
import { Empty, Problem, Toolbar } from '../common'
import { ago } from '../format'
import { Button } from '../ui/button'
import { Input } from '../ui/fields'
import { NativeSelect } from '../ui/select'
import type { TabProps } from './page'

/** Newest items shown at most; the export has them all. */
const SHOWN = 300

/** The filters, per pool: kept while the pool changes live and while the user goes to another tab. */
const filters = new Map<string, TimelineFilter>()

export function Activity({ pool, state }: TabProps) {
  const [filter, setFilter] = useState<TimelineFilter>(() => filters.get(pool.id) ?? {})
  const [problem, setProblem] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const change = (next: TimelineFilter) => {
    filters.set(pool.id, next)
    setFilter(next)
  }
  const items = timeline(state)
  const shown = filterTimeline(items, filter)
  const title = `${state.info?.name ?? 'Pool'}: activity`
  const kinds = [...new Map(items.map(item => [item.kind, item.label]))].sort()
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(timelineMarkdown(shown, title))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setProblem('This browser did not let the page copy: use the download instead.')
    }
  }
  return (
    <div className="flex flex-col gap-4">
      <Toolbar title="Activity" detail={`${shown.length} of ${items.length}`}>
        <Button variant="outline" size="sm" onClick={() => save('pool-activity.json', 'application/json', timelineJson(shown))}>
          <DownloadIcon />
          JSON
        </Button>
        <Button variant="outline" size="sm" onClick={() => save('pool-activity.md', 'text/markdown', timelineMarkdown(shown, title))}>
          <DownloadIcon />
          Markdown
        </Button>
        <Button variant="outline" size="sm" onClick={() => void copy()}>
          <CopyIcon />
          {copied ? 'Copied' : 'Copy as Markdown'}
        </Button>
      </Toolbar>
      <div className="flex flex-wrap gap-2">
        <Input
          type="search"
          className="h-8 w-full sm:w-64"
          placeholder="Search what was said or done"
          aria-label="Search the activity"
          value={filter.query ?? ''}
          onChange={event => change({ ...filter, query: event.target.value })}
        />
        <NativeSelect
          aria-label="Member"
          value={filter.account ?? ''}
          onChange={event => change({ ...filter, account: event.target.value || undefined })}
        >
          <option value="">Every member</option>
          {state.members.map(member => (
            <option key={member.account} value={member.account}>
              {member.profile?.name ?? 'A member'}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Session"
          value={filter.session ?? ''}
          onChange={event => change({ ...filter, session: event.target.value || undefined })}
        >
          <option value="">Every session</option>
          {state.sessions.map(session => (
            <option key={`${session.account}/${session.session}`} value={`${session.account}/${session.session}`}>
              {sessionName(state, session)}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Kind"
          value={filter.kind ?? ''}
          onChange={event => change({ ...filter, kind: event.target.value || undefined })}
        >
          <option value="">Everything</option>
          {kinds.map(([kind, label]) => (
            <option key={kind} value={kind}>
              {label}
            </option>
          ))}
        </NativeSelect>
      </div>
      {problem && <Problem onDismiss={() => setProblem(null)}>{problem}</Problem>}
      {shown.length ? (
        <ol className="flex flex-col gap-2">
          {shown
            .slice(-SHOWN)
            .reverse()
            .map(item => {
              const about = [
                item.taskTitle ? `Task: ${item.taskTitle}` : item.taskId ? `Task ${item.taskId}` : null,
                item.to ? `To ${item.to}` : null,
              ]
                .filter(Boolean)
                .join(' · ')
              return (
                <li key={item.id} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <strong className="font-medium">{item.who}</strong>
                    <span className="text-muted-foreground">{item.label}</span>
                    <time className="ms-auto text-xs text-muted-foreground" dateTime={item.at} title={new Date(item.at).toLocaleString()}>
                      {ago(item.at)}
                    </time>
                  </div>
                  {about && <small className="text-xs text-muted-foreground">{about}</small>}
                  {item.text && <p className="mt-1 whitespace-pre-wrap break-words">{item.text}</p>}
                </li>
              )
            })}
        </ol>
      ) : (
        <Empty>{items.length ? 'Nothing matches.' : 'Nothing happened yet.'}</Empty>
      )}
      {shown.length > SHOWN && (
        <p className="text-xs text-muted-foreground">
          The {SHOWN} latest are shown: the export has all {shown.length}.
        </p>
      )}
    </div>
  )
}

/** A file the browser saves: a link to a blob of the page's own, clicked and let go. Nothing leaves the page. */
function save(name: string, type: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
