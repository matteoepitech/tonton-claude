// The three coding tools as the client core reads them: Claude Code, OpenCode and Codex. Mirrors
// app/Tests/TontonCoreTests/CodingToolTests.swift.

import { describe, expect, test } from 'bun:test'
import { decodeClusterSessionProfile } from '../cluster'
import { decodePoolEventBody, decodePoolSessionProfile, poolTaskSize } from '../pool'
import { decodePoolMachineProfile, machinePlanLabel } from '../pool-machines'
import type { PoolMachineProfile } from '../pool-protocol'
import { CODING_TOOLS, codingToolLabel, isCodingTool } from '../session'

describe('coding tools', () => {
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
