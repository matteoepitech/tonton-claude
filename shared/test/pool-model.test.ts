// Choosing the model of a pool task (#283, shared/pool-model.ts): fixtures for easy, ordinary and demanding tasks, what
// the machine owner allows, locks and overrides, escalation after failed sessions and its limit, sparing a plan, and what
// is read back from what other members sealed.
import { describe, expect, test } from 'bun:test'
import { decodePoolTask } from '../pool'
import { decodePoolMachineProfile } from '../pool-machines'
import { assessTask, chooseModel, decodeModelPolicy, decodeTaskRoute, isModelId, type ModelChoice } from '../pool-model'
import type { PoolModelPolicy, PoolTask } from '../pool-protocol'

const docs: PoolTask = {
  title: 'Fix typos in the README',
  goal: 'Correct the spelling in the setup section.',
  criteria: ['no typos left'],
  size: 'simple',
  state: 'todo',
}
const feature: PoolTask = {
  title: 'Cart and checkout',
  goal: 'Add products to a cart and check out, on top of the catalog API.',
  criteria: ['an unknown product is refused', 'the total is the sum of the lines'],
  state: 'todo',
}
const architecture: PoolTask = {
  title: 'Redesign the sync engine',
  goal: 'Move the session store to a log every device replays, so offline edits merge.',
  criteria: ['two devices converge', 'no edit is lost offline', 'old clients still read it'],
  state: 'todo',
}
const debugging: PoolTask = {
  title: 'Find why sessions drop',
  goal: 'Debug the reconnect loop that drops sessions after sleep, and fix its root cause.',
  criteria: ['a session survives a sleep'],
  state: 'todo',
}

const chosen = (input: Parameters<typeof chooseModel>[0]): ModelChoice => chooseModel(input)

describe('assessing a task', () => {
  test('routine work is light, an ordinary feature balanced, demanding work strong', () => {
    expect(assessTask(docs)).toEqual({ tier: 'light', reason: 'a small task, routine work (typos)' })
    expect(assessTask(feature)).toEqual({ tier: 'balanced', reason: 'a feature' })
    expect(assessTask(architecture).tier).toBe('strong')
    expect(assessTask(architecture).reason).toContain('demanding work (redesign)')
    expect(assessTask(debugging).tier).toBe('strong')
  })

  test('size alone does not decide: a small task can be demanding, and a big one routine', () => {
    expect(assessTask({ ...debugging, size: 'simple' }).tier).toBe('balanced')
    expect(assessTask({ title: 'Translate the app into German', goal: 'Every string in German.', size: 'large' }).tier).toBe('light')
  })

  test('criteria, hours, dependencies and parts of the code raise it', () => {
    const big = {
      ...feature,
      criteria: ['a', 'b', 'c', 'd', 'e'],
      hours: 8,
      dependsOn: ['t1', 't2'],
      paths: ['web/', 'relay/src', 'agent/src'],
    }
    const assessed = assessTask(big)
    expect(assessed.tier).toBe('strong')
    expect(assessed.reason).toBe('a feature, 5 criteria, 8 hours, built on several tasks, 3 parts of the code')
    expect(assessTask({ ...feature, hours: 1 }).tier).toBe('light')
  })
})

describe('choosing the model', () => {
  test('by default, each tier is a Claude Code alias', () => {
    expect(chosen({ task: docs, tool: 'claude' })).toMatchObject({ tier: 'light', model: 'haiku', escalated: 0 })
    expect(chosen({ task: feature, tool: 'claude' })).toMatchObject({ tier: 'balanced', model: 'sonnet' })
    expect(chosen({ task: architecture, tool: 'claude' })).toMatchObject({ tier: 'strong', model: 'opus' })
  })

  test("the owner's models stand for the tiers, for OpenCode as for Claude Code", () => {
    const policy: PoolModelPolicy = { tiers: { light: 'openrouter/qwen3-coder', strong: 'anthropic/claude-opus-4-5' } }
    expect(chosen({ task: docs, tool: 'opencode', policy }).model).toBe('openrouter/qwen3-coder')
    expect(chosen({ task: feature, tool: 'opencode', policy }).model).toBe('sonnet')
    expect(chosen({ task: architecture, tool: 'opencode', policy }).model).toBe('anthropic/claude-opus-4-5')
  })

  test('a tier the owner does not allow goes up to the next one, or down when none is above', () => {
    const noLight: PoolModelPolicy = { allowed: ['balanced', 'strong'] }
    expect(chosen({ task: docs, tool: 'claude', policy: noLight })).toMatchObject({ tier: 'balanced', model: 'sonnet' })
    expect(chosen({ task: docs, tool: 'claude', policy: noLight }).reason).toContain('balanced as its owner does not allow light')
    const noStrong: PoolModelPolicy = { allowed: ['light', 'balanced'] }
    expect(chosen({ task: architecture, tool: 'claude', policy: noStrong })).toMatchObject({ tier: 'balanced' })
  })

  test("the owner's lock wins over everything, the task's own tier over the assessment", () => {
    const locked = chosen({ task: { ...architecture, model: 'strong', setbacks: 2 }, tool: 'claude', policy: { lock: 'light' } })
    expect(locked).toEqual({ tier: 'light', model: 'haiku', reason: 'locked to light by its owner', escalated: 0 })
    expect(chosen({ task: docs, tool: 'claude', policy: { lock: 'strong', allowed: ['light'] } }).tier).toBe('strong')
    const set = chosen({ task: { ...docs, model: 'strong' }, tool: 'claude' })
    expect(set).toMatchObject({ tier: 'strong', reason: 'set to strong for this task' })
  })

  test('a failed session climbs a tier, within the limit; the next easy task starts light again', () => {
    const once = chosen({ task: { ...feature, setbacks: 1 }, tool: 'claude' })
    expect(once).toMatchObject({ tier: 'strong', model: 'opus', escalated: 1 })
    expect(once.reason).toBe('a feature; up a tier after a session failed it')
    // One tier by default: a second failure stays where it is.
    expect(chosen({ task: { ...docs, setbacks: 2 }, tool: 'claude' })).toMatchObject({ tier: 'balanced', escalated: 1 })
    expect(chosen({ task: { ...docs, setbacks: 2 }, tool: 'claude', policy: { escalations: 2 } })).toMatchObject({
      tier: 'strong',
      escalated: 2,
    })
    expect(chosen({ task: { ...docs, setbacks: 3 }, tool: 'claude', policy: { escalations: 0 } })).toMatchObject({ tier: 'light' })
    expect(chosen({ task: { ...architecture, setbacks: 1 }, tool: 'claude' }).reason).toContain('already on the strongest tier')
    // Escalation belongs to the task that failed, not to the machine.
    expect(chosen({ task: docs, tool: 'claude' }).tier).toBe('light')
  })

  test('an account close to its limit spares its plan: strong becomes balanced, unless the task already failed', () => {
    const spared = chosen({ task: architecture, tool: 'claude', spare: 'is 92 % used' })
    expect(spared.tier).toBe('balanced')
    expect(spared.reason).toContain('balanced while the account is 92 % used')
    expect(chosen({ task: { ...feature, setbacks: 1 }, tool: 'claude', spare: 'is 92 % used' }).tier).toBe('strong')
  })

  test('an empty or unknown list of tiers allows them all, rather than leaving the machine idle', () => {
    expect(chosen({ task: docs, tool: 'claude', policy: { allowed: [] } }).tier).toBe('light')
    expect(chosen({ task: architecture, tool: 'claude', policy: { allowed: ['giant' as 'light'] } }).tier).toBe('strong')
  })
})

describe('what other members sealed', () => {
  test('a policy keeps what it understands and drops the rest', () => {
    expect(
      decodeModelPolicy({
        lock: 'huge',
        allowed: ['strong', 'light', 'giant'],
        tiers: { light: 'haiku', strong: 'opus; rm -rf ~', balanced: 7 },
        escalations: 5,
      }),
    ).toEqual({ allowed: ['light', 'strong'], tiers: { light: 'haiku' } })
    expect(decodeModelPolicy({ lock: 'balanced', escalations: 2 })).toEqual({ lock: 'balanced', escalations: 2 })
    expect(decodeModelPolicy('opus')).toBeUndefined()
    expect(decodeModelPolicy({})).toBeUndefined()
  })

  test('model names can carry nothing but a model', () => {
    for (const ok of ['sonnet', 'claude-sonnet-4-5-20250929', 'claude-opus-4-5[1m]', 'anthropic/claude-haiku-4-5', 'ollama/qwen3:32b'])
      expect(isModelId(ok)).toBe(true)
    for (const bad of ['', 'opus --dangerously-skip-permissions', 'a/b/c', '$(id)', 'x'.repeat(101), "'"])
      expect(isModelId(bad)).toBe(false)
  })

  test('a machine profile and a task keep their model fields', () => {
    const profile = decodePoolMachineProfile({
      tool: 'claude',
      capacity: 1,
      workdir: '~/pool',
      mode: 'edits',
      models: { allowed: ['light', 'balanced'] },
    })
    expect(profile?.models).toEqual({ allowed: ['light', 'balanced'] })
    const task = decodePoolTask({
      ...feature,
      model: 'strong',
      setbacks: 1,
      route: { tier: 'strong', model: 'opus', reason: 'a feature', escalated: 1, confirmed: 'claude-opus-4-5', extra: true },
    })
    expect(task).toMatchObject({ model: 'strong', setbacks: 1 })
    expect(task?.route).toEqual({ tier: 'strong', model: 'opus', reason: 'a feature', escalated: 1, confirmed: 'claude-opus-4-5' })
    expect(decodePoolTask({ ...feature, model: 'giant', setbacks: -1, route: 'opus' })).toEqual(feature)
    expect(decodeTaskRoute({ model: '$(id)' })).toBeUndefined()
  })
})
