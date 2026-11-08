// A Codex session's plan windows travel apart from Claude's and read as the session's own. Mirrors
// testCodexWindowsAreTheSessionsOwnAndApartFromClaudes in app/Tests/TontonCoreTests/SessionVaultTests.swift.

import { describe, expect, test } from 'bun:test'
import { newAccountKey, seal } from '../crypto'
import type { SessionSummary } from '../protocol'
import { Vault } from '../vault'

const key = newAccountKey()
const claude = { usedPercent: 40, resetsAt: '2026-11-08T15:00:00.000Z' }
const codex = { usedPercent: 85.5, resetsAt: '2026-11-08T17:00:00.000Z' }
const week = { usedPercent: 12, resetsAt: '2026-11-12T09:00:00.000Z' }

async function session(tool: 'codex' | undefined): Promise<SessionSummary> {
  return {
    id: 's1',
    machineId: 'm1',
    status: 'working',
    agentOnline: true,
    canChat: true,
    info: await seal(key, { machine: 'PC', cwd: '/code/api', project: 'api', ...(tool ? { tool } : {}) }),
    meta: await seal(key, { fiveHourLimit: claude, codexFiveHourLimit: codex, codexSevenDayLimit: week }),
    statusDetail: null,
    pendingPermissions: [],
    startedAt: '2026-11-08T10:00:00.000Z',
    lastActivity: '2026-11-08T10:00:00.000Z',
  }
}

describe("Codex's plan windows", () => {
  test("a Codex session's windows are its ChatGPT plan's, a Claude Code session's are Claude's", async () => {
    const vault = new Vault(key)
    const read = await vault.session(await session('codex'), [])
    expect(read.fiveHourLimit).toEqual({ usedPercent: 85.5, resetsAt: Date.parse(codex.resetsAt) })
    expect(read.sevenDayLimit).toEqual({ usedPercent: 12, resetsAt: Date.parse(week.resetsAt) })
    const other = await vault.session(await session(undefined), [])
    expect(other.fiveHourLimit).toEqual({ usedPercent: 40, resetsAt: Date.parse(claude.resetsAt) })
    expect(other.sevenDayLimit).toBeNull()
  })
})
