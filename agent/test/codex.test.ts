// Tonton's hooks and MCP server in Codex, on temporary Codex folders: installing, installing again, uninstalling, the
// user's own entries kept, and how the trust Codex recorded is read. Never the developer's ~/.codex.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODEX_HOOK_EVENTS, codexHome, codexHookCommand, hasCodex, installCodex, readCodexHooks, removeCodex } from '../src/install/codex'
import { checkCodex, codexEventKey, codexHookHash, codexHookStates } from '../src/install/codex-check'
import { parseToml, tomlString } from '../src/install/toml-table'

const BINARY = '/home/ana/.tonton/bin/tonton'
const COMMAND = "exec '/home/ana/.tonton/bin/tonton' hook codex"
const WINDOWS_BINARY = 'C:\\Users\\Jean Dupont\\.tonton\\bin\\tonton.exe'

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
})

describe('installing', () => {
  test('writes one hook per event and the MCP server, and nothing more the second time', () => {
    expect(install().changed).toBe(true)
    const hooks = JSON.parse(read(hooksFile()))
    expect(Object.keys(hooks.hooks).sort()).toEqual([...CODEX_HOOK_EVENTS].sort())
    expect(hooks.hooks.PreToolUse).toEqual([{ matcher: 'apply_patch', hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] }])
    expect(hooks.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] }])
    expect(read(configFile())).toBe('[mcp_servers.tonton]\ncommand = "/home/ana/.tonton/bin/tonton"\nargs = ["channel", "codex"]\n')
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
    expect(read(configFile())).toBe(
      `${USER_CONFIG}\n[mcp_servers.tonton]\ncommand = "/home/ana/.tonton/bin/tonton"\nargs = ["channel", "codex"]\n`,
    )
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
    expect(read(configFile())).toBe(
      `${USER_CONFIG}\n[mcp_servers.tonton]\ncommand = "/home/ana/.tonton/bin/tonton"\nargs = ["channel", "codex"]\n\n[projects."/p"]\ntrust_level = "trusted"\n`,
    )
  })

  test('keeps what the user set on the server, like turning it off, also when the agent moved', () => {
    const config = '[mcp_servers.tonton]\ncommand = "/home/ana/.tonton/bin/tonton"\nargs = ["channel", "codex"]\nenabled = false\n'
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

  test('on Windows, the paths as cmd and TOML read them', () => {
    install(WINDOWS_BINARY, 'win32')
    expect(JSON.parse(read(hooksFile())).hooks.Stop[0].hooks[0].command).toBe(`"${WINDOWS_BINARY}" hook codex`)
    expect(parseToml(read(configFile()))?.mcp_servers).toEqual({ tonton: { command: WINDOWS_BINARY, args: ['channel', 'codex'] } })
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

/** The currentHash codex app-server 0.142.2 lists for each of Tonton's hooks (hooks/list), on macOS and on Windows. */
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
    PreToolUse: 'sha256:b4010b5d026b447009c106b11717ab0c61f64ed7fc3eb4373dac206b29473f8d',
    PermissionRequest: 'sha256:26801269f7a00bc93468a80dba5a190f3b80d665b2f65a2b5ccd5f04d13b1122',
    PostToolUse: 'sha256:e8ad5802d7305085ffc59f1c4d52a530ff2b2afdb26dde8b1c74c3b7556fe3ce',
    SessionStart: 'sha256:88066cade7b7a195f11c6ffa10d9f496bf3424890c3abddc11d17a9a269c03fc',
    UserPromptSubmit: 'sha256:e6e637c66132bf79dd14eb2d020b3ee045117581ba3698ed2274c8fffb8c5683',
    Stop: 'sha256:0288ba1ee407256ed82495c1df9cefd55e2c26f88887bd7f7ff7cb87e22f939f',
  },
}

/** Records trust for Tonton's hooks as Codex's /hooks does: by file, event and place, with Codex's own hash. */
function trust(events: readonly string[] = CODEX_HOOK_EVENTS, hash = (event: string) => CODEX_HASHES[BINARY]?.[event] ?? '') {
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
        expect(codexHookHash(event, matcher, codexHookCommand(binary, platform), 5)).toBe(CODEX_HASHES[binary]?.[event] ?? '')
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
    writeFileSync(configFile(), `[features]\nhooks = false\n\n${read(configFile())}`)
    expect(checkCodex(BINARY, dir, 'darwin')).toEqual({
      ok: false,
      detail: `Hooks are turned off in Codex: features.hooks is false in ${configFile()}.`,
      repair: false,
    })
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
