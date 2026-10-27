// Claude's task list (TodoWrite in Claude Code, todowrite in OpenCode): the latest list of a conversation is the live
// one, shown as a checklist, and its progress goes in the session's meta. Mirrors app/Sources/TontonCore/TodoList.swift.

import type { Entry, TaskProgress, TodoItem } from './protocol'

/** The list the conversation's last TodoWrite set. Null when it has none, or only from agents that do not send it. */
export function latestTodos(entries: readonly Entry[]): TodoItem[] | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry.kind === 'tool' && entry.name === 'TodoWrite' && entry.todos) return entry.todos
  }
  return null
}

/** Completed tasks out of those not cancelled. Null for an empty list, or once every task is done: nothing is left to follow. */
export function taskProgress(todos: readonly TodoItem[] | null): TaskProgress | null {
  if (!todos) return null
  const counted = todos.filter(todo => todo.status !== 'cancelled')
  const done = counted.filter(todo => todo.status === 'completed').length
  return counted.length && done < counted.length ? { done, total: counted.length } : null
}
