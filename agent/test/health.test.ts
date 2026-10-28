import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  broadcastAddress,
  claudePlan,
  claudePlanOf,
  cpuLoad,
  installedTools,
  parsePmset,
  parseSysBattery,
  parseWin32Battery,
  readHealth,
  wakeTargets,
} from '../src/service/health'

describe('machine health', () => {
  test('CPU load is the busy share between two samples', () => {
    expect(cpuLoad({ busy: 100, total: 1000 }, { busy: 400, total: 2000 })).toBe(0.3)
    expect(cpuLoad({ busy: 100, total: 1000 }, { busy: 100, total: 1000 })).toBe(0)
  })

  test('macOS battery from pmset', () => {
    const onAC = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t87%; charging; 1:02 remaining present: true"
    expect(parsePmset(onAC)).toEqual({ percent: 87, charging: true })
    const onBattery = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t42%; discharging; 3:10 remaining present: true"
    expect(parsePmset(onBattery)).toEqual({ percent: 42, charging: false })
    expect(parsePmset("Now drawing from 'AC Power'")).toBeNull()
  })

  test('Linux and Windows batteries', () => {
    expect(parseSysBattery('64\n', 'Discharging\n')).toEqual({ percent: 64, charging: false })
    expect(parseSysBattery('100\n', 'Full\n')).toEqual({ percent: 100, charging: true })
    expect(parseSysBattery('', '')).toBeNull()
    expect(parseWin32Battery('{"EstimatedChargeRemaining":55,"BatteryStatus":2}')).toEqual({ percent: 55, charging: true })
    expect(parseWin32Battery('')).toBeNull()
  })

  test('Wake-on-LAN targets: physical IPv4 cards, each once, with their subnet broadcast', () => {
    expect(broadcastAddress('192.168.1.20', '255.255.255.0')).toBe('192.168.1.255')
    expect(broadcastAddress('10.0.12.7', '255.255.240.0')).toBe('10.0.15.255')
    expect(broadcastAddress('fe80::1', 'ffff::')).toBeNull()
    const entry = (fields: object) => ({
      address: '192.168.1.20',
      netmask: '255.255.255.0',
      family: 'IPv4',
      mac: 'a4:83:e7:01:02:03',
      internal: false,
      cidr: null,
      ...fields,
    })
    const targets = wakeTargets({
      en0: [entry({}), entry({ family: 'IPv6', address: 'fe80::1', netmask: 'ffff::' })],
      en1: [entry({ address: '192.168.1.21' })],
      lo0: [entry({ address: '127.0.0.1', netmask: '255.0.0.0', internal: true, mac: '00:00:00:00:00:00' })],
      utun3: [entry({ mac: '00:00:00:00:00:00', address: '10.8.0.2' })],
    } as never)
    expect(targets).toEqual([{ mac: 'a4:83:e7:01:02:03', broadcast: '192.168.1.255' }])
  })

  test('the Claude plan, from what Claude Code keeps of the signed-in account', () => {
    const account = (organizationType: string, organizationRateLimitTier?: string) => ({
      oauthAccount: { emailAddress: 'ana@example.com', organizationType, organizationRateLimitTier },
    })
    expect(claudePlanOf(account('claude_max', 'default_claude_max_20x'))).toBe('max_20x')
    expect(claudePlanOf(account('claude_max', 'default_claude_max_5x'))).toBe('max_5x')
    expect(claudePlanOf(account('claude_max'))).toBe('max_5x')
    expect(claudePlanOf(account('claude_pro', 'default_claude_ai'))).toBe('pro')
    expect(claudePlanOf(account('claude_team'))).toBe('team')
    expect(claudePlanOf(account('claude_enterprise'))).toBe('enterprise')
    expect(claudePlanOf({ primaryApiKey: 'sk-ant-…' })).toBe('api')
    // Not signed in, or a plan this agent does not know: nothing, never a guess.
    expect(claudePlanOf(account('claude_galaxy'))).toBeUndefined()
    expect(claudePlanOf({})).toBeUndefined()
    expect(claudePlanOf(null)).toBeUndefined()
  })

  test('the plan is read from the file, and nothing when it is missing or broken', () => {
    const folder = mkdtempSync(join(tmpdir(), 'tonton-plan-'))
    const file = join(folder, '.claude.json')
    expect(claudePlan(file)).toBeUndefined()
    writeFileSync(file, '{ not json')
    expect(claudePlan(file)).toBeUndefined()
    writeFileSync(file, JSON.stringify({ oauthAccount: { organizationType: 'claude_pro' } }))
    expect(claudePlan(file)).toBe('pro')
    rmSync(folder, { recursive: true, force: true })
  })

  test('a real report on this machine', () => {
    const { health, sample } = readHealth({ busy: 0, total: 0 })
    expect(health.memoryTotal).toBeGreaterThan(0)
    expect(health.memoryUsed).toBeGreaterThan(0)
    expect(health.cpu).toBeGreaterThanOrEqual(0)
    expect(health.cpu).toBeLessThanOrEqual(1)
    expect(sample.total).toBeGreaterThan(0)
    expect(Array.isArray(health.wake)).toBe(true)
  })
})

describe('installedTools', () => {
  test('the coding agents the notch can start here, Claude Code first', () => {
    expect(installedTools({ claude: () => true, opencode: () => true })).toEqual(['claude', 'opencode'])
    expect(installedTools({ claude: () => false, opencode: () => true })).toEqual(['opencode'])
    expect(installedTools({ claude: () => true, opencode: () => false })).toEqual(['claude'])
  })
})

describe('commands of the report', () => {
  test('run hidden: on Windows the service has no console, and each would open a PowerShell window', () => {
    const spawn = spyOn(Bun, 'spawnSync')
    try {
      readHealth({ busy: 0, total: 0 })
      // Linux reads its battery from files: there may be nothing to run.
      for (const [, options] of spawn.mock.calls) expect(options).toMatchObject({ windowsHide: true })
      if (process.platform !== 'linux') expect(spawn).toHaveBeenCalled()
    } finally {
      spawn.mockRestore()
    }
  })
})
