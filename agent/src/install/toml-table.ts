// Sets keys of one table of a TOML document, or takes the table out, and keeps every other byte as it is: the user's
// comments, blank lines and formatting, and the keys of that table it was not asked to set. Made for Codex's config.toml,
// which the user and Codex itself both edit. Every edit is checked by parsing the result: one that would change anything
// else is refused, and the file stays as it was.

/** The values Tonton writes: strings, and lists of strings. */
export type TomlTable = Record<string, string | string[]>

export type TomlEdit = { ok: true; text: string; changed: boolean } | { ok: false; reason: string }

type Document = Record<string, unknown>

/** The document parsed, null when it is not valid TOML. */
export function parseToml(text: string): Document | null {
  try {
    const parsed: unknown = Bun.TOML.parse(text)
    return isTable(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** The value at a path of a parsed document, undefined when there is none. */
export function tomlValueAt(document: Document, path: string[]): unknown {
  let value: unknown = document
  for (const key of path) value = isTable(value) ? value[key] : undefined
  return value
}

/**
 * Sets these keys of the table at `path`, each where it is, and keeps the table's other keys and sub-tables. Without
 * such a table, writes one at the end of the document.
 */
export function setTomlTable(text: string, path: string[], values: TomlTable): TomlEdit {
  return edit(text, path, values)
}

/** Takes the table at `path` and its sub-tables out, with the blank line that set them apart. */
export function removeTomlTable(text: string, path: string[]): TomlEdit {
  return edit(text, path, null)
}

/** A string as TOML writes it: quoted, with the characters TOML does not allow as they are escaped. */
export function tomlString(value: string): string {
  let quoted = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    quoted += SHORT_ESCAPES[char] ?? (code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, '0')}` : char)
  }
  return `"${quoted}"`
}

const SHORT_ESCAPES: Record<string, string> = { '\\': '\\\\', '"': '\\"', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r' }

const isTable = (value: unknown): value is Document => typeof value === 'object' && value !== null && !Array.isArray(value)

const tomlKey = (key: string) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key))

const keyLine = (key: string, value: string | string[], eol: string) =>
  `${tomlKey(key)} = ${Array.isArray(value) ? `[${value.map(tomlString).join(', ')}]` : tomlString(value)}${eol}`

const samePath = (a: string[], b: string[]) => a.length === b.length && a.every((key, index) => key === b[index])

function edit(text: string, path: string[], values: TomlTable | null): TomlEdit {
  const before = parseToml(text)
  if (!before) return { ok: false, reason: 'is not valid TOML' }
  const current = tomlValueAt(before, path)
  const wanted = values ? { ...(isTable(current) ? current : {}), ...values } : undefined
  if (Bun.deepEquals(current, wanted)) return { ok: true, text, changed: false }
  let found: Section[]
  try {
    found = sections(text)
  } catch {
    return { ok: false, reason: 'holds TOML this agent cannot edit' }
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const result = values ? withKeys(text, found, path, values, eol) : withoutTable(text, found, path)
  const after = parseToml(result)
  // Defined some other way (an inline table, dotted keys): what is written next to it would not parse, or not be it.
  if (!after || !Bun.deepEquals(tomlValueAt(after, path), wanted) || !Bun.deepEquals(without(after, path), without(before, path)))
    return { ok: false, reason: `defines ${path.join('.')} in a way this agent does not edit` }
  return { ok: true, text: result, changed: true }
}

/** Each key replaced where it is, the missing ones after the table's last key, or a new table at the end. */
function withKeys(text: string, found: Section[], path: string[], values: TomlTable, eol: string): string {
  const main = found.find(section => !section.array && samePath(section.path, path))
  if (!main)
    return append(
      text,
      `[${path.map(tomlKey).join('.')}]${eol}${Object.entries(values)
        .map(([key, value]) => keyLine(key, value, eol))
        .join('')}`,
      eol,
    )
  const missing = Object.entries(values).filter(([key]) => !main.keys.some(statement => samePath(statement.path, [key])))
  const head = text.slice(0, main.end)
  let result = missing.length
    ? `${head.endsWith('\n') ? head : head + eol}${missing.map(([key, value]) => keyLine(key, value, eol)).join('')}${text.slice(main.end)}`
    : text
  // From the last to the first, so that the offsets of the ones before stay right; all of them come before the new keys.
  const replaced = main.keys.filter(
    statement => statement.path.length === 1 && statement.path[0] && Object.hasOwn(values, statement.path[0]),
  )
  for (const statement of [...replaced].reverse()) {
    const key = statement.path[0] ?? ''
    result = result.slice(0, statement.start) + keyLine(key, values[key] ?? '', eol) + result.slice(statement.end)
  }
  return result
}

function withoutTable(text: string, found: Section[], path: string[]): string {
  const own = found.filter(section => path.every((key, index) => section.path[index] === key))
  // From the last to the first, so that the offsets of the ones before stay right.
  return [...own].reverse().reduce(cut, text)
}

/** The document without the value at `path`, and without the tables that only held it. */
function without(document: Document, [first, ...rest]: string[]): Document {
  if (first === undefined || !(first in document)) return document
  const { [first]: inner, ...others } = document
  if (!rest.length) return others
  if (!isTable(inner)) return document
  const kept = without(inner, rest)
  return Object.keys(kept).length ? { ...others, [first]: kept } : others
}

function cut(text: string, { start, end }: Section): string {
  const head = text.slice(0, start)
  const tail = text.slice(end)
  // The last table of the document: the blank lines that set it apart go with it.
  if (/^[ \t\r\n]*$/.test(tail)) return head.replace(/(\r?\n)(?:[ \t]*\r?\n)+$/, '$1').replace(/^[ \t\r\n]+$/, '')
  const apart = head === '' || /\n[ \t]*\r?\n$/.test(head)
  return head + (apart ? tail.replace(/^(?:[ \t]*\r?\n)+/, '') : tail)
}

function append(text: string, table: string, eol: string): string {
  if (!text.trim()) return table
  const ended = /\n$/.test(text) ? text : text + eol
  return /\n[ \t]*\r?\n$/.test(ended) ? ended + table : ended + eol + table
}

/** A `[table]` or `[[array of tables]]` and what belongs to it, as offsets in the document. */
interface Section {
  path: string[]
  array: boolean
  /** The start of the header's line. */
  start: number
  /** Just after the new line of its last key, or of the header when it has none: comments after it are left out. */
  end: number
  /** Its keys, from the start of their line to just after their new line. */
  keys: { path: string[]; start: number; end: number }[]
}

/**
 * The tables of a document that parses. Strings and arrays are read through, so a line of a multi-line string or of an
 * array that starts with `[` is not taken for a header. Throws on what it does not follow.
 */
function sections(text: string): Section[] {
  const found: Section[] = []
  let at = 0
  let current: Section | null = null

  const fail = (what: string): never => {
    throw new Error(`${what} at offset ${at}`)
  }
  const expect = (char: string) => {
    if (text[at] !== char) fail(`expected ${char}`)
    at++
  }
  const skipSpaces = () => {
    while (text[at] === ' ' || text[at] === '\t') at++
  }
  const skipComment = () => {
    if (text[at] === '#') while (at < text.length && text[at] !== '\n') at++
  }
  /** Spaces, comments and new lines, between the values of an array. */
  const skipBlank = () => {
    for (;;) {
      skipSpaces()
      skipComment()
      if (text[at] !== '\r' && text[at] !== '\n') return
      at++
    }
  }
  const endOfLine = () => {
    skipSpaces()
    skipComment()
    if (text[at] === '\r') at++
    if (at < text.length) expect('\n')
  }

  const basicString = (): string => {
    at++
    let value = ''
    for (;;) {
      const char = text[at]
      if (char === undefined || char === '\n') return fail('unterminated string')
      at++
      if (char === '"') return value
      if (char !== '\\') {
        value += char
        continue
      }
      const escaped = text[at++] ?? ''
      const length = HEX_ESCAPES[escaped]
      if (length) {
        const digits = text.slice(at, at + length)
        if (digits.length !== length || !/^[0-9a-fA-F]+$/.test(digits)) fail('bad escape')
        value += String.fromCodePoint(Number.parseInt(digits, 16))
        at += length
      } else value += UNESCAPED[escaped] ?? fail('bad escape')
    }
  }
  const literalString = (): string => {
    const close = text.indexOf("'", at + 1)
    const newline = text.indexOf('\n', at + 1)
    if (close < 0 || (newline >= 0 && newline < close)) fail('unterminated string')
    const value = text.slice(at + 1, close)
    at = close + 1
    return value
  }
  const multilineString = (quote: string) => {
    at += 3
    for (;;) {
      if (at >= text.length) fail('unterminated string')
      if (quote === '"' && text[at] === '\\') {
        at += 2
        continue
      }
      if (text.startsWith(quote.repeat(3), at)) {
        at += 3
        // Up to two quotes right before the closing ones belong to the string.
        for (let extra = 0; extra < 2 && text[at] === quote; extra++) at++
        return
      }
      at++
    }
  }

  const key = (): string[] => {
    const parts: string[] = []
    for (;;) {
      skipSpaces()
      if (text[at] === '"') parts.push(basicString())
      else if (text[at] === "'") parts.push(literalString())
      else {
        BARE_KEY.lastIndex = at
        const bare = BARE_KEY.exec(text)?.[0] ?? fail('expected a key')
        parts.push(bare)
        at += bare.length
      }
      skipSpaces()
      if (text[at] !== '.') return parts
      at++
    }
  }

  const value = () => {
    const char = text[at]
    if (text.startsWith('"""', at)) multilineString('"')
    else if (text.startsWith("'''", at)) multilineString("'")
    else if (char === '"') basicString()
    else if (char === "'") literalString()
    else if (char === '[') list('[', ']', value)
    else if (char === '{') list('{', '}', pair)
    else {
      SCALAR.lastIndex = at
      at += SCALAR.exec(text)?.[0].length ?? fail('expected a value')
    }
  }
  const pair = (): string[] => {
    const path = key()
    expect('=')
    skipSpaces()
    value()
    return path
  }
  /** An array, or an inline table, which TOML 1.1 lets span lines too. */
  const list = (open: string, close: string, item: () => void) => {
    expect(open)
    for (;;) {
      skipBlank()
      if (text[at] === close) break
      item()
      skipBlank()
      if (text[at] !== ',') break
      at++
    }
    expect(close)
  }

  while (at < text.length) {
    const lineStart = at
    skipSpaces()
    const char = text[at]
    if (char === '\r' || char === '\n' || char === '#' || char === undefined) {
      endOfLine()
      continue
    }
    if (char === '[') {
      const array = text[at + 1] === '['
      at += array ? 2 : 1
      const path = key()
      expect(']')
      if (array) expect(']')
      endOfLine()
      current = { path, array, start: lineStart, end: at, keys: [] }
      found.push(current)
      continue
    }
    const path = pair()
    endOfLine()
    if (!current) continue
    current.end = at
    current.keys.push({ path, start: lineStart, end: at })
  }
  return found
}

const BARE_KEY = /[A-Za-z0-9_-]+/y
/** Numbers, booleans and dates: up to what ends a value. A date can hold a space. */
const SCALAR = /[^,\]}#\r\n]+/y
const UNESCAPED: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\u001b', '"': '"', '\\': '\\' }
/** How many hex digits follow `\u`, `\U` and TOML 1.1's `\x`. */
const HEX_ESCAPES: Record<string, number> = { u: 4, U: 8, x: 2 }
