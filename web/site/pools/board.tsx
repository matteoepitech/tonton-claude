// The task board of a pool: one column per state, live, and the editor of a task. Members change and move tasks;
// viewers read them. A change made over a task someone else changed meanwhile is refused by the relay: the board then
// shows their version, marked, and nothing is lost silently.
import { GitBranchIcon, PlusIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import {
  assignableSessions,
  BOARD_COLUMNS,
  board,
  draftOf,
  memberName,
  moved,
  type OpenPool,
  type PoolState,
  type PoolTaskItem,
  type PoolTaskState,
  poolAbilities,
  sessionName,
  TASK_STATE_LABELS,
  type TaskDraft,
  taskHistory,
  taskOf,
  waitingOn,
} from '../../../shared'
import { Empty, Problem, Toolbar } from '../common'
import { plural } from '../format'
import { useStore } from '../store'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '../ui/dialog'
import { Field, Input, Textarea } from '../ui/fields'
import { NativeSelect } from '../ui/select'
import type { TabProps } from './page'

export function Board({ pool, state }: TabProps) {
  const store = useStore()
  const can = poolAbilities(pool.role)
  const tasks = board(state.tasks)
  // The task open in the editor: an id, or `new`.
  const [editing, setEditing] = useState<string | null>(null)
  const item = editing && editing !== 'new' ? (state.tasks.find(task => task.id === editing) ?? null) : null
  const save = async (id: string | null, task: NonNullable<ReturnType<typeof taskOf>>) =>
    (await store.pools?.saveTask(pool.id, id, task)) != null
  return (
    <div className="flex flex-col gap-4">
      <Toolbar title="Tasks" detail={can.write ? undefined : 'Read only'}>
        {can.write && (
          <Button size="sm" onClick={() => setEditing('new')}>
            <PlusIcon />
            New task
          </Button>
        )}
      </Toolbar>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        {tasks.columns.map(column => (
          <section key={column.state} className="flex flex-col gap-2 rounded-xl bg-secondary/60 p-2">
            <h3 className="flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">
              {column.label}
              <span>{column.tasks.length}</span>
            </h3>
            {column.tasks.map(task => (
              <TaskCard key={task.id} pool={pool} state={state} item={task} onOpen={() => setEditing(task.id)} onMove={save} />
            ))}
            {!column.tasks.length && <p className="px-1 text-xs text-faint">—</p>}
          </section>
        ))}
      </div>
      {tasks.unreadable.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {plural(tasks.unreadable.length, 'task')} could not be read with the keys you hold: they may have been sealed after a key change
          you were not part of.
        </p>
      )}
      <Dialog open={editing !== null} onOpenChange={open => !open && setEditing(null)}>
        {editing !== null && (
          <TaskEditor key={editing} pool={pool} state={state} item={item} onSave={save} onClose={() => setEditing(null)} />
        )}
      </Dialog>
    </div>
  )
}

function TaskCard({
  pool,
  state,
  item,
  onOpen,
  onMove,
}: {
  pool: OpenPool
  state: PoolState
  item: PoolTaskItem
  onOpen(): void
  onMove(id: string, task: NonNullable<ReturnType<typeof taskOf>>): Promise<boolean>
}) {
  const task = item.task
  if (!task) return null
  const waiting = waitingOn(state.tasks, task)
  const details = [task.area, task.assignee ? sessionName(state, task.assignee) : null].filter(Boolean).join(' · ')
  return (
    <Card className="flex flex-col gap-1.5 p-2.5">
      <button type="button" onClick={onOpen} className="flex flex-col gap-1 text-left" title="Open the task">
        <strong className="text-sm font-medium">{task.title}</strong>
        {details && <small className="text-xs text-muted-foreground">{details}</small>}
        {task.branch && (
          <small className="flex items-center gap-1 truncate font-mono text-[11px] text-muted-foreground">
            <GitBranchIcon className="size-3" />
            {task.branch}
          </small>
        )}
        {waiting.length > 0 && <small className="text-xs text-warning">Waits for {plural(waiting.length, 'task')}</small>}
        {pool.conflicts.has(item.id) && (
          <small className="text-xs text-orange">Changed meanwhile by {memberName(state, item.account)}: this is their version.</small>
        )}
      </button>
      {poolAbilities(pool.role).write && (
        <NativeSelect
          aria-label={`Move “${task.title}”`}
          value=""
          className="h-7 text-xs"
          onChange={event => {
            if (event.target.value) void onMove(item.id, moved(task, event.target.value as PoolTaskState))
          }}
        >
          <option value="">Move to…</option>
          {BOARD_COLUMNS.filter(column => column.state !== task.state).map(column => (
            <option key={column.state} value={column.state}>
              {column.label}
            </option>
          ))}
        </NativeSelect>
      )}
    </Card>
  )
}

/** A task's fields, its history, and Save for those who may write. A new task when `item` is null. */
function TaskEditor({
  pool,
  state,
  item,
  onSave,
  onClose,
}: {
  pool: OpenPool
  state: PoolState
  item: PoolTaskItem | null
  onSave(id: string | null, task: NonNullable<ReturnType<typeof taskOf>>): Promise<boolean>
  onClose(): void
}) {
  const writable = poolAbilities(pool.role).write
  const [draft, setDraft] = useState<TaskDraft>(() => draftOf(item?.task ?? null))
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (key: keyof TaskDraft) => (event: { target: { value: string } }) => setDraft({ ...draft, [key]: event.target.value })
  const sessions = assignableSessions(state)
  const known = !draft.assignee || sessions.some(s => `${s.account}/${s.session}` === draft.assignee)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const task = taskOf(draft)
    if (!task) return setProblem('A task needs a title.')
    setBusy(true)
    if (await onSave(item?.id ?? null, task)) onClose()
    else {
      setBusy(false)
      setProblem('Not saved: the relay is not connected.')
    }
  }
  const history = item ? taskHistory(state.events, item.id) : []
  return (
    <DialogContent className="max-w-2xl">
      <DialogHeader
        title={item ? 'Task' : 'New task'}
        description={item ? `Id ${item.id} · ${TASK_STATE_LABELS[item.task?.state ?? 'todo']}` : undefined}
      />
      <form onSubmit={submit} className="flex flex-col gap-3">
        <fieldset disabled={!writable} className="grid gap-3 sm:grid-cols-2">
          <Field label="Title" className="sm:col-span-2">
            <Input value={draft.title} onChange={set('title')} placeholder="The checkout page" />
          </Field>
          <Field label="Goal" className="sm:col-span-2">
            <Textarea rows={3} value={draft.goal} onChange={set('goal')} placeholder="What it is for, and the contract it follows" />
          </Field>
          <Field label="Done when" className="sm:col-span-2">
            <Textarea rows={3} value={draft.criteria} onChange={set('criteria')} placeholder="One criterion per line" />
          </Field>
          <Field label="Area">
            <Input value={draft.area} onChange={set('area')} placeholder="front, back, infra, tests…" />
          </Field>
          <Field label="State">
            <NativeSelect value={draft.state} onChange={set('state')} className="h-9">
              {BOARD_COLUMNS.map(column => (
                <option key={column.state} value={column.state}>
                  {column.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Assigned to">
            <NativeSelect value={draft.assignee} onChange={set('assignee')} className="h-9">
              <option value="">Nobody</option>
              {sessions.map(session => (
                <option key={`${session.account}/${session.session}`} value={`${session.account}/${session.session}`}>
                  {sessionName(state, session)}
                  {session.profile?.tool === 'opencode' ? ' (OpenCode)' : ''}
                </option>
              ))}
              {!known && <option value={draft.assignee}>A session that left the pool</option>}
            </NativeSelect>
          </Field>
          <Field label="Waits for">
            <Input value={draft.dependsOn} onChange={set('dependsOn')} placeholder="Task ids, separated by commas" />
          </Field>
          <Field label="Branch">
            <Input value={draft.branch} onChange={set('branch')} placeholder="feat/checkout" />
          </Field>
          <Field label="Summary" className="sm:col-span-2">
            <Textarea rows={2} value={draft.summary} onChange={set('summary')} placeholder="What was done, when it is done or blocked" />
          </Field>
        </fieldset>
        {problem && <Problem>{problem}</Problem>}
        {item && (
          <div className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium text-muted-foreground">History</h3>
            {history.length ? (
              <ol className="flex flex-col gap-1 text-xs">
                {history.map(event => (
                  <li key={event.id}>
                    {new Date(event.ts).toLocaleString()} · {memberName(state, event.account)} ·{' '}
                    {event.body?.text ?? event.body?.kind ?? ''}
                  </li>
                ))}
              </ol>
            ) : (
              <Empty className="py-1 text-left text-xs">
                Last changed by {memberName(state, item.account)}, {new Date(item.updatedAt).toLocaleString()}
              </Empty>
            )}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
          {writable && (
            <Button type="submit" disabled={busy}>
              {item ? 'Save' : 'Create'}
            </Button>
          )}
        </DialogFooter>
      </form>
    </DialogContent>
  )
}
