// The three coding tools as the client core reads them: Claude Code, OpenCode and Codex. Mirrors
// app/Tests/TontonCoreTests/CodingToolTests.swift.

import { describe, expect, test } from 'bun:test'
import { decodeClusterSessionProfile } from '../cluster'
import { decodePoolEventBody, decodePoolSessionProfile, poolTaskSize } from '../pool'
import { decodePoolMachineProfile, machinePlanLabel } from '../pool-machines'
import type { PoolMachineProfile } from '../pool-protocol'
import { CODING_TOOLS, codingToolLabel, codingToolOf, isCodingTool, mixesTools, otherToolLabel, sessionMatches } from '../session'

describe('coding tools', () => {
  test('a session names its tool beside its details only when it is not Claude Code', () => {
    expect(codingToolOf('codex')).toBe('codex')
    expect(codingToolOf(null)).toBe('claude')
    expect(codingToolOf('aider')).toBe('claude')
    expect(otherToolLabel('codex')).toBe('Codex')
    expect(otherToolLabel('opencode')).toBe('OpenCode')
    expect(otherToolLabel('claude')).toBeNull()
    expect(otherToolLabel(null)).toBeNull()
    expect(otherToolLabel('aider')).toBeNull()
  })

  test('a list mixes tools when two of them run its sessions, missing and unknown counting as Claude Code', () => {
    expect(mixesTools([{ tool: null }, { tool: 'codex' }])).toBe(true)
    expect(mixesTools([{ tool: 'opencode' }, { tool: 'codex' }])).toBe(true)
    expect(mixesTools([{ tool: null }, { tool: 'claude' }, { tool: 'aider' }])).toBe(false)
    expect(mixesTools([{ tool: 'codex' }, { tool: 'codex' }])).toBe(false)
    expect(mixesTools([])).toBe(false)
  })

  test('the session search finds a tool by its name, like the notch', () => {
    const codex = { name: null, project: 'shop', machine: 'Mac', title: 'Fix the cart', tool: 'codex' }
    const claude = { name: 'Front', project: 'web', machine: 'PC', title: null, tool: null }
    expect(sessionMatches(codex, 'codex')).toBe(true)
    expect(sessionMatches(codex, ' CODEX ')).toBe(true)
    expect(sessionMatches(claude, 'codex')).toBe(false)
    expect(sessionMatches(claude, 'claude code')).toBe(true)
    expect(sessionMatches(codex, 'cart')).toBe(true)
    expect(sessionMatches(claude, 'front')).toBe(true)
    expect(sessionMatches(claude, 'pc')).toBe(true)
    expect(sessionMatches(codex, '')).toBe(true)
    expect(sessionMatches(codex, 'opencode')).toBe(false)
  })

  test('each tool has its name, and anything else reads as Claude Code, as in the app', () => {
    expect(CODING_TOOLS).toEqual(['claude', 'opencode', 'codex'])
    expect(CODING_TOOLS.map(codingToolLabel)).toEqual(['Claude Code', 'OpenCode', 'Codex'])
    expect(codingToolLabel(null)).toBe('Claude Code')
    expect(codingToolLabel(undefined)).toBe('Claude Code')
    expect(codingToolLabel('aider')).toBe('Claude Code')
    expect(isCodingTool('codex')).toBe(true)
    expect(isCodingTool('aider')).toBe(false)
    expect(isCodingTool(3)).toBe(false)
  })

  test('cluster and pool profiles keep a Codex session and drop tools nobody runs', () => {
    expect(decodeClusterSessionProfile({ name: 'Rig', tool: 'codex' })).toEqual({ name: 'Rig', tool: 'codex' })
    expect(decodeClusterSessionProfile({ name: 'Rig', tool: 'aider' })).toEqual({ name: 'Rig' })
    expect(decodePoolSessionProfile({ area: 'back', tool: 'codex' })).toEqual({ area: 'back', tool: 'codex' })
    expect(decodePoolSessionProfile({ area: 'back', tool: 'aider' })).toEqual({ area: 'back' })
    expect(decodePoolEventBody({ kind: 'session', tool: 'codex', model: 'gpt-5-codex' })).toEqual({
      kind: 'session',
      tool: 'codex',
      model: 'gpt-5-codex',
    })
    // Codex takes the large tasks by default, like Claude Code.
    expect(poolTaskSize(null, 'codex')).toBe('large')
    expect(poolTaskSize(null, 'opencode')).toBe('simple')
  })

  test('a pool machine may run Codex, and says so', () => {
    const profile: PoolMachineProfile = { tool: 'codex', capacity: 1, workdir: '~/pool', mode: 'edits' }
    expect(decodePoolMachineProfile(profile)).toEqual(profile)
    expect(decodePoolMachineProfile({ ...profile, tool: 'aider' })).toBeNull()
    expect(machinePlanLabel({ tool: 'codex' })).toBe('Codex')
    expect(machinePlanLabel({ tool: 'opencode' })).toBe('OpenCode')
    expect(machinePlanLabel({ tool: 'claude', plan: 'max_5x' })).toBe('Claude Max 5x')
  })
})
