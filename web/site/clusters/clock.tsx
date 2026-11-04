// The cluster's clock: a deadline for everyone and the milestones on the way, for a jam, a sprint or a demo day. Every
// member sees the same time left; the owner sets it, sealed in the cluster's `clock` document. Sessions are told at each
// mark by their agents (#315).
import { CheckIcon, PlusIcon, XIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import type { ClusterClock } from '../../../shared'
import { Empty } from '../common'
import { localInput } from '../format'
import { useStore } from '../store'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { cn } from '../ui/cn'
import { Field, Input } from '../ui/fields'
import { clockView } from './model'
import type { ClusterTabProps } from './page'
import { useNow } from './page'

export function Clock({ cluster }: ClusterTabProps) {
  const now = useNow(30_000)
  const clock = clockView(cluster.clock, now)
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      {clock.label ? (
        <Card className="gap-1 p-4">
          <strong className={cn('text-3xl font-bold tracking-tight', (clock.ended || clock.lastHour) && 'text-destructive')}>
            {clock.label}
          </strong>
          <small className="text-sm text-muted-foreground">Deadline: {new Date(cluster.clock?.deadline ?? '').toLocaleString()}</small>
          {clock.next && (
            <small className="text-sm">
              Next: {clock.next.name}, {new Date(clock.next.at).toLocaleString()}
            </small>
          )}
        </Card>
      ) : (
        <Empty>No clock yet.{cluster.role === 'owner' ? ' Set a deadline below.' : ' The owner can set one.'}</Empty>
      )}
      {clock.marks.length > 0 && (
        <ol className="flex flex-col divide-y rounded-lg border bg-white">
          {clock.marks.map(mark => (
            <li key={`${mark.name}-${mark.at}`} className="flex items-center gap-3 px-4 py-2">
              {mark.passed ? <CheckIcon className="size-4 text-muted-foreground" /> : <span className="size-4" />}
              <span className={cn('flex-1', mark.passed && 'text-muted-foreground line-through')}>{mark.name}</span>
              <small className="text-xs text-muted-foreground">{new Date(mark.at).toLocaleString()}</small>
            </li>
          ))}
        </ol>
      )}
      {cluster.role === 'owner' && <ClockForm key={JSON.stringify(cluster.clock)} clusterId={cluster.id} clock={cluster.clock} />}
    </div>
  )
}

interface Draft {
  name: string
  at: string
}

/** The owner edits the deadline and the milestones; saving writes over the revision this page saw. */
function ClockForm({ clusterId, clock }: { clusterId: string; clock: ClusterClock | null }) {
  const watch = useStore().clusters
  const local = (iso?: string) => (iso && !Number.isNaN(Date.parse(iso)) ? localInput(new Date(iso)) : '')
  const [deadline, setDeadline] = useState(local(clock?.deadline))
  const [marks, setMarks] = useState<Draft[]>((clock?.milestones ?? []).map(mark => ({ name: mark.name, at: local(mark.at) })))
  const [saved, setSaved] = useState(false)
  const save = async (event: FormEvent) => {
    event.preventDefault()
    const iso = (value: string) => (value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined)
    const next: ClusterClock = {
      startedAt: clock?.startedAt ?? new Date().toISOString(),
      ...(iso(deadline) ? { deadline: iso(deadline) } : {}),
      milestones: marks.flatMap(mark => {
        const at = iso(mark.at)
        return mark.name.trim() && at ? [{ name: mark.name.trim().slice(0, 120), at }] : []
      }),
    }
    setSaved(Boolean(await watch?.setClock(clusterId, next)))
  }
  return (
    <form onSubmit={save} className="flex flex-col gap-3 rounded-lg border bg-white p-4">
      <strong>Set the clock</strong>
      <Field label="Deadline">
        <Input type="datetime-local" value={deadline} onChange={event => setDeadline(event.target.value)} />
      </Field>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-xs font-medium text-muted-foreground">Milestones</legend>
        {marks.map((mark, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: drafts have no id until they are saved
          <div key={index} className="flex gap-2">
            <Input
              aria-label="Milestone"
              value={mark.name}
              placeholder="Playable build"
              onChange={event => setMarks(marks.map((m, i) => (i === index ? { ...m, name: event.target.value } : m)))}
            />
            <Input
              aria-label="When"
              type="datetime-local"
              value={mark.at}
              onChange={event => setMarks(marks.map((m, i) => (i === index ? { ...m, at: event.target.value } : m)))}
              className="w-auto"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Remove"
              onClick={() => setMarks(marks.filter((_, i) => i !== index))}
            >
              <XIcon />
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setMarks([...marks, { name: '', at: '' }])}>
          <PlusIcon />
          Milestone
        </Button>
      </fieldset>
      <div className="flex items-center gap-3">
        <Button type="submit">Save the clock</Button>
        {saved && <small className="text-xs text-muted-foreground">Sent to every member.</small>}
      </div>
    </form>
  )
}
