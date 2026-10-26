// Claude Code names models by their API id; clients show them the way its own menu does. Mirrors `ModelName` in
// app/Sources/TontonCore/ClaudeModel.swift.

import type { ModelAlias } from './protocol'

/** The aliases `/model` takes, each standing for the latest model of its family. */
export const MODEL_ALIASES: readonly ModelAlias[] = ['opus', 'sonnet', 'haiku']

const asAlias = (text: string): ModelAlias | null => MODEL_ALIASES.find(alias => alias === text) ?? null

/** Like Swift's `Int(_:)`: digits, with an optional sign. */
const isInteger = (text: string) => /^[+-]?\d+$/.test(text)

const capitalized = (word: string) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()

function parts(id: string): { name: string; version: string[] } | null {
  const start = id.toLowerCase().indexOf('claude-')
  if (start < 0) return null
  // `[1m]` asks for a million tokens of context, `@date` and `:0` come from cloud providers.
  const rest = id
    .slice(start + 'claude-'.length)
    .toLowerCase()
    .split(/[[@:]/)[0]
  const tokens = rest.split('-').filter(token => token !== '' && token !== 'latest')
  const last = () => tokens[tokens.length - 1] ?? ''
  if (last().startsWith('v') && isInteger(last().slice(1))) tokens.pop()
  if (last().length === 8 && isInteger(last())) tokens.pop()
  const words = tokens.filter(token => !isInteger(token))
  const version = tokens.filter(isInteger)
  if (words.length !== 1 || version.length === 0 || version.some(part => part.length > 2)) return null
  return { name: words[0], version }
}

/** "Opus 4.5" for `claude-opus-4-5-20251101`, "Sonnet 3.5" for `claude-3-5-sonnet-20241022`. Other models keep their id. */
export function modelName(id: string): string {
  const alias = asAlias(id.toLowerCase())
  if (alias) return capitalized(alias)
  const found = parts(id)
  return found ? `${capitalized(found.name)} ${found.version.join('.')}` : id
}

/** The alias that switches back to this model's family, null for models `/model` has no alias for. */
export function modelFamily(id: string): ModelAlias | null {
  return asAlias(id.toLowerCase()) ?? asAlias(parts(id)?.name ?? '')
}
