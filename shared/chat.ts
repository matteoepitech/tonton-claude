// What a chat view renders from a conversation: each tool call merged with its result. Mirrors `ChatItem.build` in
// app/Sources/TontonCore/Entry.swift.

import type { Entry } from './protocol'

type EntryOf<K extends Entry['kind']> = Extract<Entry, { kind: K }>

export type ChatItem =
  | { kind: 'user'; id: string; entry: EntryOf<'user'> }
  | { kind: 'assistant'; id: string; entry: EntryOf<'assistant'> }
  | { kind: 'tool'; id: string; call: EntryOf<'tool'>; result: EntryOf<'tool_result'> | null }
  | { kind: 'system'; id: string; entry: EntryOf<'system'> }

export function chatItems(entries: readonly Entry[]): ChatItem[] {
  const results = new Map<string, EntryOf<'tool_result'>>()
  // The latest result of a call wins, as in the app.
  for (const entry of entries) if (entry.kind === 'tool_result') results.set(entry.toolUseId, entry)
  const items: ChatItem[] = []
  for (const entry of entries) {
    // A task list shows as the checklist (`latestTodos`), not as a row per update.
    if (entry.kind === 'tool' && entry.name === 'TodoWrite' && entry.todos) continue
    if (entry.kind === 'tool') items.push({ kind: 'tool', id: entry.id, call: entry, result: results.get(entry.toolUseId) ?? null })
    else if (entry.kind === 'user') items.push({ kind: 'user', id: entry.id, entry })
    else if (entry.kind === 'assistant') items.push({ kind: 'assistant', id: entry.id, entry })
    else if (entry.kind === 'system') items.push({ kind: 'system', id: entry.id, entry })
  }
  return items
}
