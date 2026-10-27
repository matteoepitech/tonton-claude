// How this machine is set up, checked on request from the app (Settings › Machines › Diagnose): the agent and its
// background service, the relay, and what the install step put in Claude Code and OpenCode. A repair redoes one part of
// the install step, nothing the user would have to undo. Sealed both ways: the result names paths and the relay.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { open, seal } from '../../shared/crypto'
import type { DiagnoseRequest, Diagnosis, SetupCheck, SetupFix } from '../../shared/protocol'
import type { RelayConnection } from './channel/relay-connection'
import { type AgentConfig, installedVersion, VERSION } from './config'
import { HOOK_EVENTS, launcherSettings } from './install/claude-settings'
import { hasOpenCode, installOpenCodePlugin } from './install/opencode'
import { currentSetup, readClaudeSettings, type Setup, writeHooks, writeLauncherSettings, writeLaunchers } from './install/setup'
import { BEGIN, launcherBlock } from './install/shell-profile'
import { IS_WINDOWS, registerMcpServer } from './install/system'
import { log } from './log'
import { claimOnce } from './once'
import { PLUGIN_FILE, pluginSource } from './opencode/plugin'
import { proxyFor, shownProxy } from './proxy'
import { autostartRegistered, disabled, registerAutostart, restartService, runningServicePid } from './service/control'
import { readStatus } from './service/status'

/** Older requests get no check, so the relay cannot replay a repair later. */
const REQUEST_TTL_MS = 10 * 60_000
/** As the relay checks it. Names the file that marks a repair as done. */
const REQUEST_ID = /^[a-z0-9]{8,32}$/
const FIXES: readonly string[] = ['service', 'hooks', 'mcp', 'launcher', 'statusline', 'opencode'] satisfies SetupFix[]
const PING_TIMEOUT_MS = 10_000
/** How long a started service has to show up before the checks run. */
const SERVICE_START_MS = 5000

/**
 * What the checks and repairs do beyond the files of a `Setup`: the background service, the relay and the claude CLI.
 * Tests give their own, so they never touch the login items or the Claude Code of the machine running them.
 */
export interface MachineAccess {
  service(): { pid: number | null; version: string | null; autostart: boolean; disabled: boolean }
  ping(config: AgentConfig): Promise<{ status: number | null; ms: number; error?: string }>
  addMcpServer(binary: string): boolean
  registerAutostart(): boolean
  restartService(options: { reload: boolean }): void
}

export const thisMachine: MachineAccess = {
  service: () => {
    const pid = runningServicePid()
    const status = readStatus()
    return { pid, version: pid && status?.pid === pid ? status.version : null, autostart: autostartRegistered(), disabled: disabled() }
  },
  ping: async config => {
    const started = Date.now()
    try {
      const response = await fetch(`${config.server}/api/agent/ping`, {
        headers: { authorization: `Bearer ${config.token}` },
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      })
      return { status: response.status, ms: Date.now() - started }
    } catch (error) {
      return { status: null, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) }
    }
  },
  addMcpServer: registerMcpServer,
  registerAutostart,
  restartService,
}

export interface DiagnoseOptions {
  /** The process answering: only the service restarts itself, once its answer is out. */
  role: 'service' | 'channel'
  setup?: Setup
  access?: MachineAccess
  now?: number
}

/** A request from the app, logged with the repair it asked for. */
export async function receiveDiagnoseRequest(
  config: AgentConfig,
  requestId: string,
  sealed: string,
  relay: Pick<RelayConnection, 'post' | 'flushed'>,
  role: DiagnoseOptions['role'],
) {
  const diagnosis = await handleDiagnoseRequest(config, requestId, sealed, relay, { role })
  if (diagnosis?.fixed) log('repair from the app', { fix: diagnosis.fixed.fix, ok: diagnosis.fixed.ok })
}

/**
 * Applies the repair the request names, if any, then answers with every check, sealed. Requests that do not open with
 * the account key, name another machine or come again get no answer; an old one gets a reason instead of checks.
 */
export async function handleDiagnoseRequest(
  config: AgentConfig,
  requestId: string,
  sealed: string,
  relay: Pick<RelayConnection, 'post' | 'flushed'>,
  { role, setup: given, access = thisMachine, now = Date.now() }: DiagnoseOptions,
): Promise<Diagnosis | null> {
  if (!REQUEST_ID.test(requestId)) return null
  const request = await open<DiagnoseRequest>(config.key, sealed).catch(() => null)
  if (!request || request.requestId !== requestId || request.machineId !== config.machineId) return null
  // Only for a request from the account: on Windows, finding the shell profiles runs PowerShell.
  const setup = given ?? currentSetup()
  const answer = (body: Pick<Diagnosis, 'checks' | 'fixed' | 'error'>) => {
    const diagnosis: Diagnosis = {
      requestId,
      machineId: config.machineId,
      at: new Date(now).toISOString(),
      version: installedVersion(),
      ...body,
    }
    relay.post(async () => ({ t: 'diagnosis', requestId, diagnosis: await seal(config.key, diagnosis) }))
    return diagnosis
  }
  if (!(Math.abs(now - Date.parse(request.issuedAt)) <= REQUEST_TTL_MS))
    return answer({ checks: [], error: 'The request expired. Check the clock of this machine.' })
  let repair: Repair | undefined
  if (request.fix !== undefined) {
    // A repair runs once, whichever process of the machine gets it, even if the relay hands it again.
    const claimed = claimOnce(join(setup.run, 'repairs'), requestId, 2 * REQUEST_TTL_MS, now)
    if (claimed === 'taken') return null
    repair =
      claimed instanceof Error
        ? { ok: false, text: `Could not record the repair: ${claimed.message}` }
        : tryRepair(request.fix, setup, role, access)
  }
  try {
    if (request.fix === 'service' && repair?.ok && role !== 'service') await serviceStarted(access)
    const fixed = request.fix !== undefined && repair ? { fix: request.fix, ok: repair.ok, text: repair.text } : undefined
    const diagnosis = answer({ checks: await diagnose(config, setup, access), fixed })
    if (repair?.afterAnswer) {
      // The service restarts itself: only once its answer has left.
      await relay.flushed()
      setTimeout(repair.afterAnswer, 500)
    }
    return diagnosis
  } catch (error) {
    return answer({ checks: [], error: `Could not check this machine: ${error instanceof Error ? error.message : error}` })
  }
}

/** Every check, in the order the app shows them. */
export async function diagnose(config: AgentConfig, setup: Setup, access: MachineAccess): Promise<SetupCheck[]> {
  const checks = [
    agentCheck(),
    serviceCheck(access.service()),
    await relayCheck(config, access),
    hooksCheck(setup),
    mcpCheck(setup),
    launcherCheck(setup),
    statusLineCheck(setup),
  ]
  return hasOpenCode(setup.openCode) ? [...checks, openCodeCheck(setup)] : checks
}

function agentCheck(): SetupCheck {
  const installed = installedVersion()
  const detail =
    VERSION === installed ? `Version ${installed}.` : `Version ${installed}. The process that answered runs ${VERSION} until it restarts.`
  return { id: 'agent', label: 'Agent', ok: true, detail }
}

function serviceCheck(service: ReturnType<MachineAccess['service']>): SetupCheck {
  const check = (ok: boolean, detail: string, fix?: SetupFix): SetupCheck => ({
    id: 'service',
    label: 'Background service',
    ok,
    detail,
    fix,
  })
  if (service.disabled) return check(false, 'Turned off on this machine (TONTON_SERVICE=off).')
  if (!service.pid) return check(false, 'Not running: the machine shows offline while no session is open.', 'service')
  const installed = installedVersion()
  if (service.version && service.version !== installed)
    return check(false, `Runs ${service.version}, though ${installed} is installed.`, 'service')
  if (!service.autostart) return check(false, 'Running, but it does not start at login.', 'service')
  return check(true, 'Running, and starts at login.')
}

async function relayCheck(config: AgentConfig, access: MachineAccess): Promise<SetupCheck> {
  const proxy = proxyFor(config.server)
  const through = proxy ? ` through ${shownProxy(proxy.url)}` : ''
  const host = new URL(config.server).host
  const check = (ok: boolean, detail: string): SetupCheck => ({ id: 'relay', label: 'Relay', ok, detail })
  const ping = await access.ping(config)
  if (ping.status === 200) return check(true, `${host} answers in ${ping.ms} ms${through}.`)
  if (ping.status === 401)
    return check(false, `${host} refused this machine's credential. Add it again with the token from Settings › Machines.`)
  if (ping.status !== null) return check(false, `${host} answered HTTP ${ping.status}${through}.`)
  return check(false, `${host} is not reachable over HTTP${through}: ${ping.error}. Hooks can't report the state of sessions.`)
}

function hooksCheck(setup: Setup): SetupCheck {
  const check = (ok: boolean, detail: string, fix?: SetupFix): SetupCheck => ({ id: 'hooks', label: 'Claude Code hooks', ok, detail, fix })
  const file = setup.claudeSettings
  const current = readClaudeSettings(file)
  // Nothing rewrites a file the user may be in the middle of editing.
  if (!current) return check(false, `${file} is not valid JSON. Fix it by hand, then repair the hooks.`)
  if (current.settings.disableAllHooks === true) return check(false, `Hooks are turned off: disableAllHooks is set in ${file}.`)
  if (current.raw === null) return check(false, `${file} does not exist yet.`, 'hooks')
  const hooks = current.settings.hooks as Record<string, unknown> | undefined
  const missing = HOOK_EVENTS.filter(event => !runsBinary(hooks?.[event], setup.binary))
  if (missing.length) return check(false, `Missing for ${missing.join(', ')}.`, 'hooks')
  return check(true, `All ${HOOK_EVENTS.length} in ${file}.`)
}

/** Whether one of the groups of an event runs this agent. Anything else in the user's settings is skipped. */
function runsBinary(groups: unknown, binary: string): boolean {
  if (!Array.isArray(groups)) return false
  return groups.some(group => {
    const hooks = (group as { hooks?: unknown } | null)?.hooks
    return Array.isArray(hooks) && hooks.some(hook => (hook as { command?: unknown } | null)?.command === binary)
  })
}

function mcpCheck(setup: Setup): SetupCheck {
  const check = (ok: boolean, detail: string, fix?: SetupFix): SetupCheck => ({ id: 'mcp', label: 'Channel', ok, detail, fix })
  let state: unknown
  try {
    state = JSON.parse(readFileSync(setup.claudeState, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return check(false, 'Claude Code has not run on this machine yet.', 'mcp')
    return check(false, `Could not read ${setup.claudeState}.`)
  }
  // Claude Code's own file, which changes between versions: only the server entry is read.
  const server = (state as { mcpServers?: Record<string, { command?: unknown }> } | null)?.mcpServers?.tonton
  if (!server) return check(false, 'Claude Code does not know the tonton MCP server, so sessions show no conversation.', 'mcp')
  if (server.command !== setup.binary) return check(false, `The tonton MCP server runs ${String(server.command)}, not this agent.`, 'mcp')
  return check(true, 'The tonton MCP server is registered for every project.')
}

function launcherCheck(setup: Setup): SetupCheck {
  const check = (ok: boolean, detail: string, fix?: SetupFix): SetupCheck => ({ id: 'launcher', label: 'claude launcher', ok, detail, fix })
  if (!setup.profiles.length)
    return check(false, 'No zsh, bash or PowerShell profile here: start claude with --dangerously-load-development-channels server:tonton.')
  const read = (file: string) => {
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return ''
    }
  }
  const current = setup.profiles.filter(({ file, shell }) => read(file).includes(launcherBlock(shell, setup.launcherSettings)))
  if (current.length === setup.profiles.length) return check(true, `In ${current.map(profile => profile.file).join(', ')}.`)
  const others = setup.profiles.filter(profile => !current.includes(profile))
  const older = others.filter(({ file }) => read(file).includes(BEGIN))
  const detail = older.length
    ? `Out of date in ${older.map(profile => profile.file).join(', ')}.`
    : `Missing from ${others.map(profile => profile.file).join(', ')}: sessions started there can't take messages from the notch.`
  return check(false, detail, 'launcher')
}

function statusLineCheck(setup: Setup): SetupCheck {
  const check = (ok: boolean, detail: string, fix?: SetupFix): SetupCheck => ({ id: 'statusline', label: 'Status line', ok, detail, fix })
  let current: string | null = null
  try {
    current = readFileSync(setup.launcherSettings, 'utf8')
  } catch {}
  const expected = launcherSettings(setup.binary, setup.home, IS_WINDOWS)
  if (current === null) return check(false, 'Not set up: the notch gets no plan usage from sessions.', 'statusline')
  if (!sameJson(current, expected)) return check(false, 'Set up for another agent: the notch gets no plan usage.', 'statusline')
  const last = lastUsageReading(setup.run)
  return check(true, last === null ? 'Set up. No session has reported plan usage yet.' : `Last reading from a session ${ago(last)}.`)
}

function openCodeCheck(setup: Setup): SetupCheck {
  const check = (ok: boolean, detail: string, fix?: SetupFix): SetupCheck => ({ id: 'opencode', label: 'OpenCode plugin', ok, detail, fix })
  let current: string | null = null
  try {
    current = readFileSync(join(setup.openCode, 'plugins', PLUGIN_FILE), 'utf8')
  } catch {}
  if (current === pluginSource([setup.binary, 'opencode'])) return check(true, 'Installed. OpenCode loads it when it starts.')
  return check(false, current === null ? 'OpenCode is here without the Tonton plugin.' : 'Out of date.', 'opencode')
}

interface Repair {
  ok: boolean
  text: string
  /** Runs once the answer has left. */
  afterAnswer?: () => void
}

function tryRepair(fix: string, setup: Setup, role: DiagnoseOptions['role'], access: MachineAccess): Repair {
  try {
    return repairs(fix, setup, role, access)
  } catch (error) {
    return { ok: false, text: `The repair failed: ${error instanceof Error ? error.message : error}` }
  }
}

function repairs(fix: string, setup: Setup, role: DiagnoseOptions['role'], access: MachineAccess): Repair {
  if (!FIXES.includes(fix)) return { ok: false, text: 'This agent does not know that repair. Update it first.' }
  switch (fix as SetupFix) {
    case 'hooks':
      return writeHooks(setup)
        ? { ok: true, text: 'Hooks added. Sessions started from now on report their state.' }
        : { ok: false, text: `${setup.claudeSettings} is not valid JSON: fix it by hand first.` }
    case 'mcp':
      return access.addMcpServer(setup.binary)
        ? { ok: true, text: 'MCP server registered. Sessions started from now on show their conversation.' }
        : { ok: false, text: 'The agent could not run claude here. Run the install command on this machine.' }
    case 'launcher': {
      if (!setup.profiles.length) return { ok: false, text: 'There is no shell profile to add the launcher to.' }
      writeLauncherSettings(setup)
      return { ok: true, text: `Launcher added to ${writeLaunchers(setup).join(', ')}. It works in new terminals.` }
    }
    case 'statusline':
      writeLauncherSettings(setup)
      return { ok: true, text: 'Status line set up for sessions started from now on.' }
    case 'opencode':
      installOpenCodePlugin(setup.binary, setup.openCode)
      return { ok: true, text: 'Plugin written. Restart OpenCode to load it.' }
    case 'service':
      return repairService(role, access)
  }
}

function repairService(role: DiagnoseOptions['role'], access: MachineAccess): Repair {
  const service = access.service()
  if (service.disabled) return { ok: false, text: 'The service is turned off on this machine (TONTON_SERVICE=off).' }
  const atLogin = access.registerAutostart()
    ? 'It starts at login.'
    : "This system can't start it at login (no user systemd). Sessions still work."
  const restart = !service.pid || (service.version !== null && service.version !== installedVersion())
  if (!restart) return { ok: true, text: atLogin }
  if (role === 'service')
    return {
      ok: true,
      text: `The service restarts on the installed agent. ${atLogin}`,
      afterAnswer: () => access.restartService({ reload: false }),
    }
  access.restartService({ reload: true })
  return { ok: true, text: `The service starts. ${atLogin}` }
}

async function serviceStarted(access: MachineAccess) {
  for (let waited = 0; waited < SERVICE_START_MS && !access.service().pid; waited += 250) await Bun.sleep(250)
}

function sameJson(text: string, expected: unknown): boolean {
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(expected)
  } catch {
    return false
  }
}

/** When a session's status line last left plan usage for its channel. */
function lastUsageReading(run: string): number | null {
  try {
    const times = readdirSync(run)
      .filter(file => /^usage-.*\.json$/.test(file))
      .map(file => statSync(join(run, file)).mtimeMs)
    return times.length ? Math.max(...times) : null
  } catch {
    return null
  }
}

function ago(time: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - time) / 60_000))
  if (minutes < 1) return 'less than a minute ago'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  return `${Math.round(hours / 24)} days ago`
}
