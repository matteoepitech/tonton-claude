// Tonton's hooks and MCP server in Codex, on temporary Codex folders: installing, installing again, uninstalling, the
// user's own entries kept, and how the trust Codex recorded is read. Never the developer's ~/.codex.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CODEX_ENV_VARS,
  CODEX_HOOK_EVENTS,
  codexHome,
  codexHookCommand,
  codexHookCommandWindows,
  codexHookGroup,
  codexRunCommand,
  hasCodex,
  installCodex,
  readCodexHooks,
  removeCodex,
} from '../src/install/codex'
import { checkCodex, codexEventKey, codexHookHash, codexHookStates } from '../src/install/codex-check'
import { parseToml, tomlString } from '../src/install/toml-table'

const BINARY = '/home/ana/.tonton/bin/tonton'
const COMMAND = "exec '/home/ana/.tonton/bin/tonton' hook codex"
const WINDOWS_BINARY = 'C:\\Users\\Jean Dupont\\.tonton\\bin\\tonton.exe'
const WINDOWS_COMMAND = "& 'C:\\Users\\Jean Dupont\\.tonton\\bin\\tonton.exe' hook codex"
/** What the channel needs passed on from Codex's environment, as config.toml lists it. */
const ENV_VARS = `env_vars = [${CODEX_ENV_VARS.map(name => `"${name}"`).join(', ')}]`
const SERVER = `[mcp_servers.tonton]\ncommand = "/home/ana/.tonton/bin/tonton"\nargs = ["channel", "codex"]\n${ENV_VARS}\n`

const root = mkdtempSync(join(tmpdir(), 'tonton-codex-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let dir: string
let count = 0
beforeEach(() => {
  dir = join(root, `codex-${++count}`)
  mkdirSync(dir)
})

const hooksFile = () => join(dir, 'hooks.json')
const configFile = () => join(dir, 'config.toml')
const read = (file: string) => readFileSync(file, 'utf8')
const install = (binary = BINARY, platform: NodeJS.Platform = 'darwin') => {
  const result = installCodex(binary, dir, platform)
  if (!result.ok) throw new Error(result.reason)
  return result
}

/** Hooks of the user's own, around which Tonton's go. */
const USER_HOOKS = {
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/audit', timeout: 30 }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
    PreCompact: [{ hooks: [{ type: 'command', command: 'notify compacting' }] }],
  },
}

/** A config.toml of the user's: comments, other servers, and trust Codex recorded for the user's own hooks. */
const USER_CONFIG = `# Codex, as I like it
model = "gpt-5.5" # the default
approval_policy = "on-request"

[mcp_servers.docs]
command = "npx"
args = ["-y", "docs-mcp"]

[hooks.state."/home/ana/.codex/hooks.json:pre_tool_use:0:0"]
trusted_hash = "sha256:1234"
`

describe('finding Codex', () => {
  test('its folder is CODEX_HOME, else ~/.codex', () => {
    expect(codexHome({}, '/home/ana')).toBe(join('/home/ana', '.codex'))
    expect(codexHome({ CODEX_HOME: '/data/codex' }, '/home/ana')).toBe('/data/codex')
    expect(codexHome({ CODEX_HOME: '' }, '/home/ana')).toBe(join('/home/ana', '.codex'))
  })

  test('it is there when its folder exists or codex is on the PATH', () => {
    expect(hasCodex(dir, () => false)).toBe(true)
    expect(hasCodex(join(dir, 'missing'), () => false)).toBe(false)
    expect(hasCodex(join(dir, 'missing'), () => true)).toBe(true)
  })
})

describe('the hook command', () => {
  test('on macOS and Linux, exec hands the shell over to the agent', () => {
    expect(codexHookCommand(BINARY, 'darwin')).toBe(COMMAND)
    expect(codexHookCommand("/home/o'neil/.tonton/bin/tonton", 'linux')).toBe(`exec '/home/o'\\''neil/.tonton/bin/tonton' hook codex`)
  })

  test('on Windows, no exec, and quotes only when cmd needs them', () => {
    expect(codexHookCommand('C:\\Users\\jean\\.tonton\\bin\\tonton.exe', 'win32')).toBe(
      'C:\\Users\\jean\\.tonton\\bin\\tonton.exe hook codex',
    )
    expect(codexHookCommand('C:\\Users\\Jérôme\\.tonton\\bin\\tonton.exe', 'win32')).toBe(
      'C:\\Users\\Jérôme\\.tonton\\bin\\tonton.exe hook codex',
    )
    expect(codexHookCommand(WINDOWS_BINARY, 'win32')).toBe(`"${WINDOWS_BINARY}" hook codex`)
  })

  test('on Windows, Codex runs it with PowerShell: through the call operator, the path in single quotes', () => {
    expect(codexHookCommandWindows(WINDOWS_BINARY)).toBe(WINDOWS_COMMAND)
    expect(codexHookCommandWindows("C:\\Users\\O'Neil\\.tonton\\bin\\tonton.exe")).toBe(
      "& 'C:\\Users\\O''Neil\\.tonton\\bin\\tonton.exe' hook codex",
    )
    const hook = codexHookGroup('Stop', WINDOWS_BINARY, 'win32').hooks[0]
    expect(hook).toEqual({ type: 'command', command: `"${WINDOWS_BINARY}" hook codex`, command_windows: WINDOWS_COMMAND, timeout: 5 })
    expect(hook && [codexRunCommand(hook, 'win32'), codexRunCommand(hook, 'darwin')]).toEqual([
      WINDOWS_COMMAND,
      `"${WINDOWS_BINARY}" hook codex`,
    ])
    // Elsewhere there is no Windows to run it on.
    expect(codexHookGroup('Stop', BINARY, 'darwin').hooks[0]).toEqual({ type: 'command', command: COMMAND, timeout: 5 })
  })
})

describe('installing', () => {
  test('writes one hook per event and the MCP server, and nothing more the second time', () => {
    expect(install().changed).toBe(true)
    const hooks = JSON.parse(read(hooksFile()))
    expect(Object.keys(hooks.hooks).sort()).toEqual([...CODEX_HOOK_EVENTS].sort())
    expect(hooks.hooks.PreToolUse).toEqual([{ matcher: 'apply_patch', hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] }])
    expect(hooks.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] }])
    expect(read(configFile())).toBe(SERVER)
    const [before, config] = [read(hooksFile()), read(configFile())]
    expect(install().changed).toBe(false)
    expect([read(hooksFile()), read(configFile())]).toEqual([before, config])
  })

  test("adds Tonton's hooks after the user's, whose places Codex's trust is keyed by", () => {
    writeFileSync(hooksFile(), JSON.stringify(USER_HOOKS, null, 2))
    writeFileSync(configFile(), USER_CONFIG)
    install()
    const { hooks } = JSON.parse(read(hooksFile()))
    expect(hooks.PreToolUse[0]).toEqual(USER_HOOKS.hooks.PreToolUse[0])
    expect(hooks.PreToolUse[1].hooks[0].command).toBe(COMMAND)
    expect(hooks.Stop[0]).toEqual(USER_HOOKS.hooks.Stop[0])
    expect(hooks.PreCompact).toEqual(USER_HOOKS.hooks.PreCompact)
    expect(read(configFile())).toBe(`${USER_CONFIG}\n${SERVER}`)
    // The user's file as it was, once.
    expect(JSON.parse(read(`${hooksFile()}.tonton-backup`))).toEqual(USER_HOOKS)
  })

  test('replaces an older hook of Tonton where it is, so hooks the user added after it keep their place', () => {
    const old = { hooks: [{ type: 'command', command: `"${BINARY}" hook codex` }] }
    const after = { hooks: [{ type: 'command', command: 'echo after' }] }
    writeFileSync(hooksFile(), JSON.stringify({ hooks: { Stop: [USER_HOOKS.hooks.Stop[0], old, after] } }))
    install()
    const stop = JSON.parse(read(hooksFile())).hooks.Stop
    expect(stop).toEqual([USER_HOOKS.hooks.Stop[0], { hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] }, after])
  })

  test('points the MCP server at an agent that moved, in place', () => {
    writeFileSync(
      configFile(),
      `${USER_CONFIG}\n[mcp_servers.tonton]\ncommand = "/old/tonton"\nargs = ["channel"]\n\n[projects."/p"]\ntrust_level = "trusted"\n`,
    )
    install()
    expect(read(configFile())).toBe(`${USER_CONFIG}\n${SERVER}\n[projects."/p"]\ntrust_level = "trusted"\n`)
  })

  test("passes the channel Codex's environment it needs, after the variables the user passes on", () => {
    writeFileSync(configFile(), '[mcp_servers.tonton]\ncommand = "/old/tonton"\nenv_vars = ["DEBUG", "TONTON_HOME"]\n')
    install()
    const listed = parseToml(read(configFile()))?.mcp_servers as { tonton: { env_vars: string[] } }
    expect(listed.tonton.env_vars).toEqual(['DEBUG', 'TONTON_HOME', ...CODEX_ENV_VARS.filter(name => name !== 'TONTON_HOME')])
    expect(install().changed).toBe(false)
    // A list in a shape this agent does not write is the user's.
    const own =
      '[mcp_servers.tonton]\ncommand = "/home/ana/.tonton/bin/tonton"\nargs = ["channel", "codex"]\nenv_vars = [{ name = "TOKEN", source = "local" }]\n'
    writeFileSync(configFile(), own)
    expect(install().changed).toBe(false)
    expect(read(configFile())).toBe(own)
    expect(checkCodex(BINARY, dir, 'darwin').detail).not.toContain('out of date')
  })

  test('keeps what the user set on the server, like turning it off, also when the agent moved', () => {
    const config = `[mcp_servers.tonton]\ncommand = "/home/ana/.tonton/bin/tonton"\nargs = ["channel", "codex"]\nenabled = false\n${ENV_VARS}\n`
    writeFileSync(configFile(), config)
    expect(install().changed).toBe(true)
    expect(read(configFile())).toBe(config)
    writeFileSync(configFile(), `${config.replace(BINARY, '/old/tonton')}\n[mcp_servers.tonton.env]\nDEBUG = "1"\n`)
    install()
    expect(read(configFile())).toBe(`${config}\n[mcp_servers.tonton.env]\nDEBUG = "1"\n`)
    expect(checkCodex(BINARY, dir, 'darwin')).toMatchObject({
      ok: false,
      repair: false,
      detail: expect.stringContaining('enabled = false'),
    })
  })

  test("moves no hook of the user's: groups mixing theirs and Tonton's, or a Tonton hook twice, stay as they are", () => {
    const mixed = {
      hooks: [
        { type: 'command', command: `"${BINARY}" hook codex` },
        { type: 'command', command: 'say stop' },
      ],
    }
    const twice = { hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] }
    writeFileSync(hooksFile(), JSON.stringify({ hooks: { Stop: [mixed, USER_HOOKS.hooks.Stop[0]], SessionStart: [twice, twice] } }))
    install()
    const { hooks } = JSON.parse(read(hooksFile()))
    expect(hooks.Stop).toEqual([mixed, USER_HOOKS.hooks.Stop[0], { hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] }])
    expect(hooks.SessionStart).toEqual([twice, twice])
  })

  test('knows the hooks of an agent installed elsewhere, and replaces them where they are', () => {
    const elsewhere = { hooks: [{ type: 'command', command: "exec '/opt/tonton/bin/tonton' hook codex", timeout: 5 }] }
    writeFileSync(hooksFile(), JSON.stringify({ hooks: { Stop: [elsewhere, USER_HOOKS.hooks.Stop[0]] } }))
    install()
    expect(JSON.parse(read(hooksFile())).hooks.Stop[0].hooks[0].command).toBe(COMMAND)
  })

  test('on Windows, the paths as PowerShell, cmd and TOML read them', () => {
    install(WINDOWS_BINARY, 'win32')
    expect(JSON.parse(read(hooksFile())).hooks.Stop[0].hooks[0]).toMatchObject({
      command: `"${WINDOWS_BINARY}" hook codex`,
      command_windows: WINDOWS_COMMAND,
    })
    expect(parseToml(read(configFile()))?.mcp_servers).toEqual({
      tonton: { command: WINDOWS_BINARY, args: ['channel', 'codex'], env_vars: CODEX_ENV_VARS },
    })
    expect(install(WINDOWS_BINARY, 'win32').changed).toBe(false)
  })

  test('on Windows, an install from before PowerShell is replaced where it is', () => {
    const older = { hooks: [{ type: 'command', command: `"${WINDOWS_BINARY}" hook codex`, timeout: 5 }] }
    writeFileSync(hooksFile(), JSON.stringify({ hooks: { Stop: [USER_HOOKS.hooks.Stop[0], older] } }))
    install(WINDOWS_BINARY, 'win32')
    expect(JSON.parse(read(hooksFile())).hooks.Stop).toEqual([USER_HOOKS.hooks.Stop[0], codexHookGroup('Stop', WINDOWS_BINARY, 'win32')])
  })

  test('a file Codex could not read either is left alone, and so is the other one', () => {
    writeFileSync(hooksFile(), '{ "hooks": ')
    writeFileSync(configFile(), USER_CONFIG)
    expect(installCodex(BINARY, dir, 'darwin')).toEqual({ ok: false, reason: `${hooksFile()} is not a hooks file Codex can read` })
    expect([read(hooksFile()), read(configFile())]).toEqual(['{ "hooks": ', USER_CONFIG])
    writeFileSync(hooksFile(), JSON.stringify(USER_HOOKS))
    writeFileSync(configFile(), '[mcp_servers]\ntonton = { command = "/x" }\n')
    expect(installCodex(BINARY, dir, 'darwin')).toEqual({
      ok: false,
      reason: `${configFile()} defines mcp_servers.tonton in a way this agent does not edit`,
    })
    expect(read(hooksFile())).toBe(JSON.stringify(USER_HOOKS))
  })
})

describe('uninstalling', () => {
  test("takes Tonton's entries out and gives the user's files back", () => {
    writeFileSync(hooksFile(), JSON.stringify(USER_HOOKS, null, 2))
    writeFileSync(configFile(), USER_CONFIG)
    install()
    expect(removeCodex(BINARY, dir, 'darwin')).toMatchObject({ ok: true, changed: true })
    expect(JSON.parse(read(hooksFile()))).toEqual(USER_HOOKS)
    expect(read(configFile())).toBe(USER_CONFIG)
    expect(removeCodex(BINARY, dir, 'darwin')).toMatchObject({ ok: true, changed: false })
  })

  test('removes the files Tonton alone wrote', () => {
    install()
    removeCodex(BINARY, dir, 'darwin')
    expect(existsSync(hooksFile())).toBe(false)
    expect(existsSync(configFile())).toBe(false)
  })

  test('takes out an agent installed elsewhere too, and keeps an event the user left empty', () => {
    const elsewhere = { hooks: [{ type: 'command', command: '"D:\\tools\\tonton.exe" hook codex' }] }
    writeFileSync(hooksFile(), JSON.stringify({ hooks: { Stop: [elsewhere], PreCompact: [] } }))
    removeCodex(BINARY, dir, 'darwin')
    expect(JSON.parse(read(hooksFile()))).toEqual({ hooks: { PreCompact: [] } })
  })

  test('leaves a folder with nothing of Tonton as it is', () => {
    writeFileSync(hooksFile(), '{"hooks":{}}')
    expect(removeCodex(BINARY, dir, 'darwin')).toMatchObject({ ok: true, changed: false })
    expect(read(hooksFile())).toBe('{"hooks":{}}')
    expect(existsSync(configFile())).toBe(false)
  })
})

/**
 * The currentHash codex app-server 0.142.2 lists for each of Tonton's hooks (hooks/list), on macOS and on Windows. Codex
 * hashes the command it runs, `command_windows` on Windows: its hashes are those of hooks with that command, as a Codex
 * on macOS lists them.
 */
const CODEX_HASHES: Record<string, Record<string, string>> = {
  [BINARY]: {
    PreToolUse: 'sha256:52078ddc9dce2c3888df2673a78d7fc905d3838956606e431870fffefcb66df4',
    PermissionRequest: 'sha256:9e1f6c60938d6155ffb1b09ad6c620c7786c3badd74622ca5bb2dcc17baf766a',
    PostToolUse: 'sha256:861fc3f4e2c9f02312bff712428bb474ce0e7f9738b584eb828166938e57c658',
    SessionStart: 'sha256:7002fadc6b464e3247a591e7ce806f576e3258f470efc04cd0328b52ece1f615',
    UserPromptSubmit: 'sha256:a7baa33378383a730e2e4f99dd95bb1696486437334e7c6c36130646e4ec8fd0',
    Stop: 'sha256:c1e6663a852bb2e888be1126c5f130761b77b8ce6ea0ef6edadb2f5fd98f2d14',
  },
  [WINDOWS_BINARY]: {
    PreToolUse: 'sha256:e6120d37b93d55e2c59a12f3a23201769ac7f0d8cdd0e4a66c0f0fca9eb939d5',
    PermissionRequest: 'sha256:c56b369a01284bd807973d323d13fadb4351b8f6c42860b9e3f0d5b11d9235fe',
    PostToolUse: 'sha256:a4b0c68096ca4a2e8ff3cf3fef60be423a9cff8cfd45ddc33fd31c6959c4b647',
    SessionStart: 'sha256:fb4d55826299554b857262836223eed2370e7f7d32703f1865c1c534da3c8fdb',
    UserPromptSubmit: 'sha256:96faa41b878f3a96662ecb110a41e41e855de1ff7326a4a617c1ef9aa9b5b0c5',
    Stop: 'sha256:45b3390e62e0346af71d608a6d7eb4fbc6b20366d8ffd355d0b3be774b43886d',
  },
}

/** Records trust for Tonton's hooks as Codex's /hooks does: by file, event and place, with Codex's own hash. */
function trust(events: readonly string[] = CODEX_HOOK_EVENTS, hashOf?: (event: string) => string, binary = BINARY) {
  const hash = hashOf ?? ((event: string) => CODEX_HASHES[binary]?.[event] ?? '')
  const file = join(realpathSync(dir), 'hooks.json')
  const states = events.map(
    event => `[hooks.state.${tomlString(`${file}:${codexEventKey(event)}:0:0`)}]\ntrusted_hash = "${hash(event)}"\n`,
  )
  writeFileSync(configFile(), `${read(configFile())}\n${states.join('\n')}`)
}

describe("Codex's trust", () => {
  test('hooks are hashed as Codex 0.142.2 hashes them', () => {
    for (const [binary, platform] of [
      [BINARY, 'darwin'],
      [WINDOWS_BINARY, 'win32'],
    ] as const) {
      for (const event of CODEX_HOOK_EVENTS) {
        const matcher = event === 'PreToolUse' ? 'apply_patch' : undefined
        const hook = codexHookGroup(event, binary, platform).hooks[0]
        expect(codexHookHash(event, matcher, (hook && codexRunCommand(hook, platform)) ?? '', 5)).toBe(CODEX_HASHES[binary]?.[event] ?? '')
      }
    }
    // Codex reads no matcher for these two, and leaves it out of the hash.
    expect(codexHookHash('Stop', 'anything', COMMAND, 5)).toBe(codexHookHash('Stop', undefined, COMMAND, 5))
  })

  test('the states Codex recorded for this file are found through the links of its path', () => {
    const link = join(root, `link-${count}`)
    symlinkSync(dir, link)
    const real = join(realpathSync(dir), 'hooks.json')
    const config = {
      hooks: {
        state: {
          [`${real}:stop:1:0`]: { trusted_hash: 'sha256:aa' },
          [`${real}:pre_tool_use:0:0`]: { enabled: false },
          '/elsewhere/.codex/hooks.json:stop:0:0': { trusted_hash: 'sha256:bb' },
        },
      },
    }
    const states = codexHookStates(config, join(link, 'hooks.json'))
    expect([...states]).toEqual([
      ['stop:1:0', { trustedHash: 'sha256:aa' }],
      ['pre_tool_use:0:0', { enabled: false }],
    ])
  })

  test('nothing installed: everything to repair', () => {
    expect(checkCodex(BINARY, dir, 'darwin')).toEqual({
      ok: false,
      detail: `In ${dir}: Tonton's hooks are missing; the tonton MCP server is missing.`,
      repair: true,
    })
  })

  test('installed but not trusted: the user has to trust them, no repair can', () => {
    install()
    expect(checkCodex(BINARY, dir, 'darwin')).toEqual({
      ok: false,
      detail: "Installed, but Codex runs a hook only once you trust it: open /hooks in Codex and trust Tonton's hooks.",
      repair: false,
    })
    trust(['SessionStart', 'Stop'])
    expect(checkCodex(BINARY, dir, 'darwin').detail).toBe(
      'Not trusted yet: UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse. Open /hooks in Codex and trust them.',
    )
  })

  test('trusted, all of them', () => {
    install()
    trust()
    expect(checkCodex(BINARY, dir, 'darwin')).toEqual({
      ok: true,
      detail: `Hooks trusted, and the tonton MCP server set up, in ${dir}.`,
      repair: false,
    })
  })

  test('trusted on Windows, by the hash of the command PowerShell runs', () => {
    install(WINDOWS_BINARY, 'win32')
    trust(CODEX_HOOK_EVENTS, undefined, WINDOWS_BINARY)
    expect(checkCodex(WINDOWS_BINARY, dir, 'win32')).toMatchObject({ ok: true })
  })

  test('an install from before the environment was passed on is out of date, and a repair fixes it', () => {
    install()
    trust()
    writeFileSync(configFile(), read(configFile()).replace(`${ENV_VARS}\n`, ''))
    expect(checkCodex(BINARY, dir, 'darwin')).toEqual({
      ok: false,
      detail: `In ${dir}: the tonton MCP server is out of date.`,
      repair: true,
    })
    install()
    expect(checkCodex(BINARY, dir, 'darwin')).toMatchObject({ ok: true })
  })

  test('trusted before they changed, or turned off in /hooks', () => {
    install()
    trust(CODEX_HOOK_EVENTS, event => (event === 'Stop' ? 'sha256:older' : (CODEX_HASHES[BINARY]?.[event] ?? '')))
    expect(checkCodex(BINARY, dir, 'darwin').detail).toBe(
      "Trusted before they changed, as far as this agent reads Codex's hashes: Stop. Open /hooks in Codex and trust them again.",
    )
    writeFileSync(configFile(), `${read(configFile())}enabled = false\n`)
    expect(checkCodex(BINARY, dir, 'darwin').detail).toBe("Turned off in Codex's /hooks: Stop.")
  })

  test('an older install, a server that runs something else, or hooks turned off in Codex', () => {
    writeFileSync(hooksFile(), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `"${BINARY}" hook codex` }] }] } }))
    writeFileSync(configFile(), '[mcp_servers.tonton]\ncommand = "/old/tonton"\nargs = ["channel"]\n')
    expect(checkCodex(BINARY, dir, 'darwin')).toEqual({
      ok: false,
      detail: `In ${dir}: Tonton's hooks are out of date; the tonton MCP server runs /old/tonton, not this agent.`,
      repair: true,
    })
    install()
    const server = read(configFile())
    writeFileSync(configFile(), `[features]\nhooks = false\n\n${server}`)
    expect(checkCodex(BINARY, dir, 'darwin')).toEqual({
      ok: false,
      detail: `Hooks are turned off in Codex: features.hooks is false in ${configFile()}.`,
      repair: false,
    })
    // `codex_hooks` is the older name, which `hooks` overrides when both are set.
    writeFileSync(configFile(), `[features]\ncodex_hooks = false\n\n${server}`)
    expect(checkCodex(BINARY, dir, 'darwin').detail).toBe(
      `Hooks are turned off in Codex: features.codex_hooks is false in ${configFile()}.`,
    )
    writeFileSync(configFile(), `[features]\ncodex_hooks = false\nhooks = true\n\n${server}`)
    expect(checkCodex(BINARY, dir, 'darwin').detail).not.toContain('turned off')
  })

  test('files Codex could not read are reported, not repaired', () => {
    writeFileSync(configFile(), 'model = ')
    expect(checkCodex(BINARY, dir, 'darwin')).toEqual({
      ok: false,
      detail: `${configFile()} is not valid TOML. Fix it by hand, then repair Codex.`,
      repair: false,
    })
    writeFileSync(hooksFile(), '[]')
    expect(checkCodex(BINARY, dir, 'darwin').detail).toBe(
      `${hooksFile()} is not a hooks file Codex can read. Fix it by hand, then repair Codex.`,
    )
  })
})

/** Asks a real `codex app-server`, on the given folder, for the hooks it found: what /hooks shows. */
async function codexHooks(
  home: string,
): Promise<{ hooks: { command: string; trustStatus: string; currentHash: string }[]; warnings: string[] }> {
  const cwd = join(home, 'project')
  mkdirSync(cwd, { recursive: true })
  const child = Bun.spawn(['codex', 'app-server'], {
    env: { ...process.env, CODEX_HOME: home },
    cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`)
  send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'tonton-test', title: null, version: '0' }, capabilities: null } })
  send({ method: 'initialized' })
  send({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } })
  let buffer = ''
  try {
    for await (const chunk of child.stdout) {
      buffer += new TextDecoder().decode(chunk)
      for (const line of buffer.split('\n').slice(0, -1)) {
        const message = JSON.parse(line)
        if (message.id === 2) return message.result.data[0]
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n') + 1)
    }
    throw new Error('codex app-server closed without an answer')
  } finally {
    child.kill()
  }
}

describe.skipIf(!Bun.which('codex'))('with the Codex of this machine', () => {
  test('it finds the hooks, untrusted, then trusted once its user trusts them', async () => {
    writeFileSync(hooksFile(), JSON.stringify(USER_HOOKS))
    writeFileSync(configFile(), USER_CONFIG)
    install()
    const listed = await codexHooks(dir)
    expect(listed.warnings).toEqual([])
    const tonton = listed.hooks.filter(hook => hook.command === COMMAND)
    expect(tonton.map(hook => hook.trustStatus)).toEqual(CODEX_HOOK_EVENTS.map(() => 'untrusted'))
    expect(listed.hooks.filter(hook => hook.command !== COMMAND)).toHaveLength(3)
    // Tonton's hooks go after the user's: in PreToolUse, at the second place.
    writeFileSync(
      configFile(),
      `${read(configFile())}\n${CODEX_HOOK_EVENTS.map(event => {
        const key = `${join(realpathSync(dir), 'hooks.json')}:${codexEventKey(event)}:${event === 'PreToolUse' || event === 'Stop' ? 1 : 0}:0`
        return `[hooks.state.${tomlString(key)}]\ntrusted_hash = "${CODEX_HASHES[BINARY]?.[event]}"\n`
      }).join('\n')}`,
    )
    expect((await codexHooks(dir)).hooks.filter(hook => hook.command === COMMAND).map(hook => hook.trustStatus)).toEqual(
      CODEX_HOOK_EVENTS.map(() => 'trusted'),
    )
    expect(checkCodex(BINARY, dir, 'darwin')).toMatchObject({ ok: true })
    expect(readCodexHooks(hooksFile())?.hooks.hooks?.PreCompact).toEqual(USER_HOOKS.hooks.PreCompact)
  }, 60_000)
})
