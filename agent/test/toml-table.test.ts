// The editor of one TOML table: what it writes, and that it leaves the rest of the user's file as it was.
import { describe, expect, test } from 'bun:test'
import { parseToml, removeTomlTable, setTomlTable, tomlString } from '../src/install/toml-table'

const PATH = ['mcp_servers', 'tonton']
const TABLE = { command: '/home/ana/.tonton/bin/tonton', args: ['channel', 'codex'] }
const WRITTEN = '[mcp_servers.tonton]\ncommand = "/home/ana/.tonton/bin/tonton"\nargs = ["channel", "codex"]\n'

/** A config.toml with what trips a line-by-line editor: headers inside strings and arrays, comments everywhere. */
const USER = `# Codex, as I like it
model = "gpt-5.5" # the default
approval_policy = 'on-request'

notes = """
[mcp_servers.tonton]
command = "not a table, a string"
"""

matrix = [
  [1, 2],   # a line that starts with [
  [3],
]

[mcp_servers.docs]
command = "npx"
args = ["-y", "docs-mcp"]
env = { TOKEN_FILE = "~/.docs" }

# Projects I trust
[projects."/Users/ana/code/app"]
trust_level = "trusted"
`

const set = (text: string) => {
  const result = setTomlTable(text, PATH, TABLE)
  if (!result.ok) throw new Error(result.reason)
  return result
}
const remove = (text: string) => {
  const result = removeTomlTable(text, PATH)
  if (!result.ok) throw new Error(result.reason)
  return result
}

describe('adding the table', () => {
  test('to an empty file, or none', () => {
    expect(set('').text).toBe(WRITTEN)
  })

  test('at the end, after a blank line, and the rest stays byte for byte', () => {
    const { text, changed } = set(USER)
    expect(changed).toBe(true)
    expect(text).toBe(`${USER}\n${WRITTEN}`)
    expect(parseToml(text)?.notes).toBe('[mcp_servers.tonton]\ncommand = "not a table, a string"\n')
  })

  test('after a last line with no new line', () => {
    expect(set('model = "o3"').text).toBe(`model = "o3"\n\n${WRITTEN}`)
  })

  test('with the new lines of the file', () => {
    const windows = USER.replace(/\n/g, '\r\n')
    expect(set(windows).text).toBe(`${windows}\r\n${WRITTEN.replace(/\n/g, '\r\n')}`)
  })

  test('twice: the second time changes nothing', () => {
    const once = set(USER).text
    expect(set(once)).toEqual({ ok: true, text: once, changed: false })
  })
})

describe('setting its keys when it is there', () => {
  test('each where it is, and what the user added to it stays: other keys, sub-tables, comments', () => {
    const old = `model = "o3"

[mcp_servers.tonton]
# Turned off for now
enabled = false
command = "/old/tonton"
startup_timeout_sec = 30
args = [
  "channel",
]

[mcp_servers.tonton.env]
DEBUG = "1"

# Projects I trust
[projects."/p"]
trust_level = "trusted"
`
    expect(set(old).text).toBe(`model = "o3"

[mcp_servers.tonton]
# Turned off for now
enabled = false
command = "/home/ana/.tonton/bin/tonton"
startup_timeout_sec = 30
args = ["channel", "codex"]

[mcp_servers.tonton.env]
DEBUG = "1"

# Projects I trust
[projects."/p"]
trust_level = "trusted"
`)
  })

  test('the missing ones after its last key, before the comments that follow', () => {
    expect(set('[mcp_servers.tonton]\ncommand = "/old"\n# next\n[x]\n').text).toBe(
      '[mcp_servers.tonton]\ncommand = "/home/ana/.tonton/bin/tonton"\nargs = ["channel", "codex"]\n# next\n[x]\n',
    )
    expect(set('[mcp_servers.tonton]\nenabled = false').text).toBe(`[mcp_servers.tonton]\nenabled = false\n${WRITTEN.slice(21)}`)
  })

  test('with its header as the user wrote it, quotes and spaces', () => {
    const old = `[ mcp_servers . "tonton" ]\ncommand = "/old"\n`
    expect(set(old).text).toBe(`[ mcp_servers . "tonton" ]\n${WRITTEN.slice(21)}`)
  })

  test('a table only its sub-tables defined gets its keys at the end', () => {
    const old = '[mcp_servers.tonton.env]\nDEBUG = "1"\n'
    expect(set(old).text).toBe(`${old}\n${WRITTEN}`)
  })

  test('without touching a server whose name only starts the same', () => {
    const other = '[mcp_servers.tontonette]\ncommand = "x"\n'
    expect(set(other).text).toBe(`${other}\n${WRITTEN}`)
    expect(remove(`${other}\n${WRITTEN}`).text).toBe(other)
  })
})

describe('removing it', () => {
  test('gives the file back as it was', () => {
    expect(remove(set(USER).text)).toEqual({ ok: true, text: USER, changed: true })
    expect(remove(WRITTEN).text).toBe('')
  })

  test('from the middle, with Codex tables written after it', () => {
    const codex = `[hooks.state."/Users/ana/.codex/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:00"\n`
    expect(remove(`model = "o3"\n\n${WRITTEN}\n${codex}`).text).toBe(`model = "o3"\n\n${codex}`)
  })

  test('when it is not there, changes nothing', () => {
    expect(remove(USER)).toEqual({ ok: true, text: USER, changed: false })
  })
})

describe('what it refuses to edit', () => {
  test('a file that is not TOML', () => {
    expect(setTomlTable('model = ', PATH, TABLE)).toEqual({ ok: false, reason: 'is not valid TOML' })
    expect(removeTomlTable('[a]\nb = 1\n[a]\n', PATH)).toEqual({ ok: false, reason: 'is not valid TOML' })
  })

  test('the server written another way: an inline table, dotted keys, or servers in an inline table', () => {
    const refused = { ok: false as const, reason: 'defines mcp_servers.tonton in a way this agent does not edit' }
    for (const text of [
      '[mcp_servers]\ntonton = { command = "/x" }\n',
      'mcp_servers.tonton.command = "/x"\n',
      '[mcp_servers]\ntonton.command = "/x"\n',
    ]) {
      expect(setTomlTable(text, PATH, TABLE)).toEqual(refused)
      expect(removeTomlTable(text, PATH)).toEqual(refused)
    }
    expect(setTomlTable('mcp_servers = { docs = { command = "npx" } }\n', PATH, TABLE)).toEqual(refused)
  })
})

test('strings are quoted so TOML reads them back as they were', () => {
  const values = ['C:\\Users\\Jean Dupont\\.tonton\\bin\\tonton.exe', 'say "hi"', 'tab\tnew\nline\u0001\u007f', 'Jérôme 🎉']
  for (const value of values) expect(parseToml(`x = ${tomlString(value)}`)?.x).toBe(value)
  expect(tomlString('C:\\a "b"')).toBe('"C:\\\\a \\"b\\""')
})
