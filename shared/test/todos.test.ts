import { expect, test } from 'bun:test'
import { chatItems } from '../chat'
import { decodeEntry, decodeSessionMeta } from '../payloads'
import type { Entry, TodoItem } from '../protocol'
import { latestTodos, taskProgress } from '../todos'

const todoWrite = (id: string, statuses: TodoItem['status'][]): Entry => ({
  id,
  ts: 't',
  kind: 'tool',
  toolUseId: id,
  name: 'TodoWrite',
  summary: 'Updated the task list',
  todos: statuses.map((status, i) => ({ content: `task ${i}`, status })),
})

test('the live list is the last TodoWrite, and it leaves the conversation for the checklist', () => {
  const entries: Entry[] = [
    { id: 'u1', ts: 't', kind: 'user', text: 'Fix it' },
    todoWrite('t1', ['pending', 'pending']),
    { id: 't1:result', ts: 't', kind: 'tool_result', toolUseId: 't1', text: 'ok', isError: false },
    todoWrite('t2', ['completed', 'in_progress']),
    // From an older agent: no list, so it stays a row.
    { id: 't3', ts: 't', kind: 'tool', toolUseId: 't3', name: 'TodoWrite', summary: 'Updated the task list' },
  ]
  expect(latestTodos(entries)?.map(todo => todo.status)).toEqual(['completed', 'in_progress'])
  expect(chatItems(entries).map(item => item.id)).toEqual(['u1', 't3'])
  expect(latestTodos([])).toBeNull()
})

test('progress counts what is done out of what is not cancelled, and stops once all is done', () => {
  const todos = (statuses: TodoItem['status'][]): TodoItem[] => statuses.map((status, i) => ({ content: `task ${i}`, status }))
  expect(taskProgress(todos(['completed', 'in_progress', 'pending', 'cancelled']))).toEqual({ done: 1, total: 3 })
  expect(taskProgress(todos(['completed', 'cancelled']))).toBeNull()
  expect(taskProgress(todos([]))).toBeNull()
  expect(taskProgress(null)).toBeNull()
})

test('the client reads the list and the progress as the app does', () => {
  const entry = decodeEntry({
    ...todoWrite('t1', []),
    todos: [
      { content: 'a', status: 'in_progress', activeForm: 'Doing a' },
      { content: 'b', status: 'someday' },
    ],
  })
  expect(entry?.kind === 'tool' && entry.todos).toEqual([
    { content: 'a', status: 'in_progress', activeForm: 'Doing a' },
    { content: 'b', status: 'pending' },
  ])
  // A list of the wrong shape fails the entry, as in the app.
  expect(decodeEntry({ ...todoWrite('t1', []), todos: [{ content: 3 }] })).toBeNull()
  expect(decodeSessionMeta({ title: 'x', tasks: { done: 2, total: 5 } })).toEqual({ title: 'x', tasks: { done: 2, total: 5 } })
})
