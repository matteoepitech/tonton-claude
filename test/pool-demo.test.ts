// The local demo pool (scripts/pool-demo.ts, docs/pool-autopilot.md) run to the end: the orchestrator machine's session
// writes the plan and starts the dispatch, the control loop hands each task to the machine that fits it, a task waits for
// the one it depends on, every branch reaches the sample project, and the loop stops once all of it is done.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { canRunDemo, DEMO_PLAN, type PoolDemo, startPoolDemo } from '../scripts/pool-demo'
import type { PoolState } from '../shared/pool'

let demo: PoolDemo | undefined
const state = () => demo?.state()

async function eventually<T>(read: () => T | undefined | null | false, label: string, tries = 1800): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const value = read()
    if (value) return value
    await Bun.sleep(100)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const task = (current: PoolState, title: string) => current.tasks.find(item => item.task?.title === title)
const machineOf = (current: PoolState, title: string) =>
  demo?.machines.find(m => m.id === task(current, title)?.task?.machine?.machine)?.name

beforeAll(async () => {
  if (canRunDemo()) demo = await startPoolDemo({ port: 0 })
}, 120_000)

afterAll(() => demo?.stop())

describe.skipIf(!canRunDemo())('the demo pool', () => {
  test('the orchestrator plans the sample project and the loop gets every task done', async () => {
    const done = await eventually(() => {
      const current = state()
      const tasks = current?.tasks.filter(item => item.task) ?? []
      return tasks.length === DEMO_PLAN.tasks.length && tasks.every(item => item.task?.state === 'done') && current
    }, 'every task done')
    expect(done.notes?.sections?.goal).toBe(DEMO_PLAN.goal)
    // The simple task goes to the machine that takes simple tasks; the features never do.
    expect(machineOf(done, 'README and setup')).toBe('Lead')
    for (const title of ['Product catalog API', 'Cart and checkout', 'Landing page']) expect(machineOf(done, title)).not.toBe('Lead')
    // Each session started on the model its task needs, and said so before it got the task (shared/pool-model.ts).
    expect(task(done, 'README and setup')?.task?.route).toMatchObject({ tier: 'light', model: 'haiku', confirmed: 'claude-haiku-stand-in' })
    expect(task(done, 'Cart and checkout')?.task?.route).toMatchObject({ tier: 'balanced', confirmed: 'claude-sonnet-stand-in' })
  }, 200_000)

  test('the cart waits until the catalog it is built on is merged', () => {
    const current = state() as PoolState
    const catalog = task(current, 'Product catalog API')?.id
    const cart = task(current, 'Cart and checkout')
    expect(cart?.task?.dependsOn).toEqual([catalog as string])
    const at = (kind: string, id: string | undefined, text?: string) =>
      current.events.findIndex(e => e.body?.kind === kind && e.body.taskId === id && (text === undefined || e.body.text === text))
    expect(at('task_moved', catalog, 'done')).toBeGreaterThan(-1)
    // It starts once the catalog is merged into main, not just done.
    expect(at('merged', catalog)).toBeGreaterThan(at('task_moved', catalog, 'done'))
    expect(at('dispatched', cart?.id)).toBeGreaterThan(at('merged', catalog))
  })

  test('each task is pushed on its own branch of the sample project, and the loop stops', async () => {
    const current = state() as PoolState
    const result = Bun.spawnSync(['git', 'branch', '--list', 'pool/*'], { cwd: demo?.origin, stdout: 'pipe' })
    const branches = result.stdout.toString()
    for (const item of current.tasks) expect(branches).toContain(item.task?.branch as string)
    await eventually(() => state()?.dispatch?.value?.on === false, 'the dispatch stopped')
    expect(state()?.events.some(e => e.body?.kind === 'dispatch_done')).toBe(true)
  }, 60_000)
})
