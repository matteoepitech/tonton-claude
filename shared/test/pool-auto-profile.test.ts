// A machine joins a pool with nothing asked of its owner: the profile comes from what its agent reports. The same cases
// run in app/Tests/TontonCoreTests/PoolMachineTests.swift.
import { describe, expect, test } from 'bun:test'
import {
  autoPoolMachineProfile,
  bestOrchestrator,
  decodePoolMachineProfile,
  machinePlanLabel,
  machinesToAdd,
  runsPoolMachines,
} from '../pool-machines'
import type { PoolMachineMode } from '../pool-protocol'
import type { ClaudePlan, MachineHealth } from '../protocol'
import type { Machine } from '../session'
import cases from './pool-auto-profile.json'

interface Case {
  name: string
  machine: { name: string; health: { tools: ('claude' | 'opencode')[]; plan?: ClaudePlan; memoryTotal: number } | null }
  pool: { id: string; name?: string }
  mode: PoolMachineMode
  profile: object | null
}

describe('a machine joins a pool on its own', () => {
  for (const c of cases.cases as Case[]) {
    test(c.name, () => {
      const profile = autoPoolMachineProfile(c.machine, c.pool, c.mode)
      expect(profile).toEqual(c.profile as never)
      // What every member reads back of it.
      if (profile) expect(decodePoolMachineProfile(JSON.parse(JSON.stringify(profile)))).toEqual(profile)
    })
  }

  test('what each machine brings, in a few words', () => {
    expect(machinePlanLabel({ tool: 'claude', plan: 'max_20x' })).toBe('Claude Max 20x')
    expect(machinePlanLabel({ tool: 'claude', plan: 'pro' })).toBe('Claude Pro')
    expect(machinePlanLabel({ tool: 'claude' })).toBe('Claude Code')
    expect(machinePlanLabel({ tool: 'claude', plan: 'max_50x' as ClaudePlan })).toBe('Claude Code')
    expect(machinePlanLabel({ tool: 'opencode' })).toBe('OpenCode')
    expect(machinePlanLabel(null)).toBe('Claude Code')
  })
})

const GB = 1024 ** 3
const machine = (id: string, fields: Partial<Machine>, health: Partial<MachineHealth> | null = {}): Machine => ({
  id,
  name: id,
  platform: 'darwin',
  createdAt: null,
  lastSeen: null,
  online: true,
  agentVersion: '0.9.3',
  health: health && { cpu: 0, memoryUsed: 0, memoryTotal: 64 * GB, battery: null, tools: ['claude'], at: 'x', ...health },
  ...fields,
})

describe('the machines that join with their member', () => {
  test('agents that run pool machines, development builds included', () => {
    expect(runsPoolMachines({ agentVersion: '0.9.0' })).toBe(true)
    expect(runsPoolMachines({ agentVersion: '0.10.1' })).toBe(true)
    expect(runsPoolMachines({ agentVersion: '0.0.0' })).toBe(true)
    expect(runsPoolMachines({ agentVersion: '0.8.9' })).toBe(false)
    expect(runsPoolMachines({ agentVersion: null })).toBe(false)
  })

  test('every machine of the account that can work and is not in the pool yet, online first', () => {
    const machines = [
      machine('offline', { online: false }, { plan: 'pro' }),
      machine('studio', {}, { plan: 'max_20x' }),
      machine('old', { agentVersion: '0.8.0' }),
      machine('server', {}, { tools: [] }),
      machine('already', {}),
    ]
    const picks = machinesToAdd(machines, { id: 'AbCdEfGhIjKl', name: 'Shop', machines: [{ machine: 'already' }] }, 'full')
    expect(picks.map(pick => pick.machine.id)).toEqual(['studio', 'offline'])
    expect(picks[0].profile).toMatchObject({ tool: 'claude', capacity: 3, mode: 'full', plan: 'max_20x' })
  })

  test('the orchestrator: Claude Code, online, the largest plan', () => {
    const profile = (tool: 'claude' | 'opencode', plan?: ClaudePlan) => ({
      tool,
      capacity: 1,
      workdir: '~/p',
      mode: 'edits' as const,
      plan,
    })
    const open = { id: 'open', online: true, profile: profile('opencode') }
    const pro = { id: 'pro', online: true, profile: profile('claude', 'pro') }
    const max = { id: 'max', online: true, profile: profile('claude', 'max_5x') }
    const away = { id: 'away', online: false, profile: profile('claude', 'max_20x') }
    expect(bestOrchestrator([open, pro, away, max])?.id).toBe('max')
    expect(bestOrchestrator([away, open])?.id).toBe('away')
    expect(bestOrchestrator([open])).toBeNull()
  })
})
