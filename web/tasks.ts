// The task board of a pool: one column per state, live from the pool's snapshot and changes, and the editor of a task.
// Members change and move tasks; viewers read them. A change made over a task someone else changed meanwhile is refused
// by the relay: the board then shows their version, marked, and nothing is lost silently.

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
} from '../shared'
import { element } from './markdown'

export interface BoardContext {
  pool: OpenPool
  state: PoolState
  /** Opens a form in the page's panel, which the live changes leave alone while it is being filled in. */
  openPanel(panel: HTMLElement | null): void
  save(id: string | null, task: NonNullable<ReturnType<typeof taskOf>>): Promise<boolean>
}

export function renderBoard(body: HTMLElement, context: BoardContext) {
  const { pool, state } = context
  const can = poolAbilities(pool.role)
  const tasks = board(state.tasks)
  const add = element('button', 'New task')
  add.className = 'primary'
  add.onclick = () => context.openPanel(taskEditor(context, null))
  const toolbar = element('div', element('h2', 'Tasks'), ...(can.write ? [add] : [element('small', 'Read only')]))
  toolbar.className = 'pool-toolbar'

  const columns = element('div')
  columns.className = 'board'
  for (const column of tasks.columns) {
    const list = element('div', element('h3', column.label, element('small', String(column.tasks.length))))
    list.className = 'column'
    list.dataset.state = column.state
    for (const item of column.tasks) list.append(card(context, item))
    if (!column.tasks.length) list.append(element('p', '—'))
    columns.append(list)
  }
  const children: HTMLElement[] = [toolbar, columns]
  if (tasks.unreadable.length) {
    children.push(
      element(
        'p',
        `${tasks.unreadable.length} task${tasks.unreadable.length === 1 ? '' : 's'} could not be read with the keys you hold: they may have been sealed after a key change you were not part of.`,
      ),
    )
  }
  body.replaceChildren(...children)
}

function card(context: BoardContext, item: PoolTaskItem): HTMLElement {
  const { pool, state } = context
  const task = item.task
  if (!task) return element('div')
  const lines: (string | HTMLElement)[] = [element('strong', task.title)]
  const details = [task.area, task.assignee ? sessionName(state, task.assignee) : null, task.branch ? `⎇ ${task.branch}` : null].filter(
    (part): part is string => Boolean(part),
  )
  if (details.length) lines.push(element('small', details.join(' · ')))
  const waiting = waitingOn(state.tasks, task)
  if (waiting.length) lines.push(element('small', `Waits for ${waiting.length} task${waiting.length === 1 ? '' : 's'}`))
  if (pool.conflicts.has(item.id)) {
    const note = element('small', `Changed meanwhile by ${memberName(state, item.account)}: this is their version.`)
    note.className = 'conflict'
    lines.push(note)
  }
  const open = element('button', ...lines)
  open.className = 'task'
  open.title = 'Open the task'
  open.onclick = () => context.openPanel(taskEditor(context, item))
  const wrap = element('div', open)
  wrap.className = 'task-card'
  if (poolAbilities(pool.role).write) {
    const move = element('select')
    move.setAttribute('aria-label', `Move “${task.title}”`)
    move.append(element('option', 'Move to…'))
    for (const column of BOARD_COLUMNS) {
      if (column.state === task.state) continue
      const option = element('option', column.label)
      option.value = column.state
      move.append(option)
    }
    move.onchange = () => {
      if (move.value) void context.save(item.id, moved(task, move.value as PoolTaskState))
    }
    wrap.append(move)
  }
  return wrap
}

/** A task's fields, its history, and Save for those who may write. A new task when `item` is null. */
function taskEditor(context: BoardContext, item: PoolTaskItem | null): HTMLElement {
  const { pool, state } = context
  const writable = poolAbilities(pool.role).write
  const draft = draftOf(item?.task ?? null)
  const fields: { [K in keyof TaskDraft]?: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement } = {}

  const row = (label: string, control: HTMLElement) => element('label', element('span', label), control)
  const input = (key: keyof TaskDraft, placeholder = '') => {
    const field = element('input')
    field.value = draft[key]
    field.placeholder = placeholder
    field.disabled = !writable
    fields[key] = field
    return field
  }
  const area = (key: keyof TaskDraft, placeholder = '') => {
    const field = element('textarea')
    field.value = draft[key]
    field.placeholder = placeholder
    field.rows = 3
    field.disabled = !writable
    fields[key] = field
    return field
  }
  const stateField = element('select')
  for (const column of BOARD_COLUMNS) {
    const option = element('option', column.label)
    option.value = column.state
    option.selected = column.state === draft.state
    stateField.append(option)
  }
  stateField.disabled = !writable
  fields.state = stateField
  const assignee = element('select')
  assignee.append(element('option', 'Nobody'))
  assignee.options[0].value = ''
  for (const session of assignableSessions(state)) {
    const value = `${session.account}/${session.session}`
    const tool = session.profile?.tool === 'opencode' ? ' (OpenCode)' : ''
    const option = element('option', `${sessionName(state, session)}${tool}`)
    option.value = value
    option.selected = value === draft.assignee
    assignee.append(option)
  }
  if (draft.assignee && ![...assignee.options].some(option => option.value === draft.assignee)) {
    const gone = element('option', 'A session that left the pool')
    gone.value = draft.assignee
    gone.selected = true
    assignee.append(gone)
  }
  assignee.disabled = !writable
  fields.assignee = assignee

  const error = element('p')
  error.className = 'error'
  error.setAttribute('aria-live', 'polite')
  const close = element('button', 'Close')
  close.type = 'button'
  close.onclick = () => context.openPanel(null)
  const save = element('button', item ? 'Save' : 'Create')
  save.className = 'primary'
  save.hidden = !writable
  const form = element(
    'form',
    element('h3', item ? 'Task' : 'New task'),
    row('Title', input('title', 'The checkout page')),
    row('Goal', area('goal', 'What it is for, and the contract it follows')),
    row('Done when', area('criteria', 'One criterion per line')),
    row('Area', input('area', 'front, back, infra, tests…')),
    row('State', stateField),
    row('Assigned to', assignee),
    row('Waits for', input('dependsOn', 'Task ids, separated by commas')),
    row('Branch', input('branch', 'feat/checkout')),
    row('Summary', area('summary', 'What was done, when it is done or blocked')),
    error,
    element('div', close, save),
  )
  form.className = 'pool-form'
  form.onsubmit = async event => {
    event.preventDefault()
    const read = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field?.value ?? ''])) as unknown as TaskDraft
    const task = taskOf(read)
    if (!task) {
      error.textContent = 'A task needs a title.'
      return
    }
    save.disabled = true
    if (await context.save(item?.id ?? null, task)) context.openPanel(null)
    else {
      save.disabled = false
      error.textContent = 'Not saved: the relay is not connected.'
    }
  }
  if (item) {
    const history = taskHistory(state.events, item.id)
    const list = element('ol')
    list.className = 'history'
    for (const event of history) {
      const when = new Date(event.ts).toLocaleString()
      list.append(element('li', `${when} · ${memberName(state, event.account)} · ${event.body?.text ?? event.body?.kind ?? ''}`))
    }
    if (!history.length)
      list.append(element('li', `Last changed by ${memberName(state, item.account)}, ${new Date(item.updatedAt).toLocaleString()}`))
    const id = element('small', `Id ${item.id} · ${TASK_STATE_LABELS[item.task?.state ?? 'todo']}`)
    form.append(element('h3', 'History'), list, id)
  }
  return form
}
