// The island's cluster page (web/cluster-views.ts, renderClusterPage), on a small stand-in for the DOM: one of your
// sessions set to live that its agent says gets digests says why, with Live anyway one click away when it skips
// permission prompts; an older agent, or someone else's session, shows what it showed before.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { ClusterSession, ClusterSessionProfile, ClusterState, OpenCluster, Session } from '../../shared'
import type { DeliveryOption } from '../site/clusters/model'
import { FakeElement, useFakeDom } from './fake-dom'

let renderClusterPage: typeof import('../cluster-views').renderClusterPage
let removeDom = () => {}
const saved = new Map<string, string>()

beforeAll(async () => {
  removeDom = useFakeDom()
  // What the island remembers of the choices it made, as the browser's storage keeps them.
  Object.assign(globalThis, {
    localStorage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) },
  })
  ;({ renderClusterPage } = await import('../cluster-views'))
})

afterEach(() => saved.clear())

// Other test files run in the same process, without a DOM.
afterAll(() => {
  removeDom()
  Reflect.deleteProperty(globalThis, 'localStorage')
})

const TURNED = { delivery: 'digest', skipsPrompts: true } as const

const member = (account: string, id: string, profile: ClusterSessionProfile): ClusterSession => ({
  account,
  session: id,
  machine: 'm1',
  joinedAt: '2026-11-04T10:00:00Z',
  online: true,
  ready: true,
  status: 'idle',
  profile: { name: id, machine: 'mac', tool: 'claude', ...profile },
})

function state(sessions: ClusterSession[]): ClusterState {
  return {
    id: 'cluster00001',
    createdAt: '2026-11-04T10:00:00Z',
    keyVersion: 1,
    info: { name: 'Jam' },
    members: [
      { account: 'me', role: 'owner', joinedAt: '', profile: { name: 'Me' }, publicKeys: [] },
      { account: 'ana', role: 'member', joinedAt: '', profile: { name: 'Ana' }, publicKeys: [] },
    ],
    sessions,
    posts: [],
    docs: [],
    own: { secret: null, wraps: [] },
  }
}

const own = (id: string): Session =>
  ({
    id,
    machine: 'mac',
    project: id,
    name: id,
    title: null,
    status: 'idle',
    agentOnline: true,
    pendingPermissions: [],
  }) as unknown as Session

function render(sessions: ClusterSession[]) {
  const page = new FakeElement('div')
  const putIn: [string, DeliveryOption][] = []
  const cluster = {
    id: 'cluster00001',
    role: 'owner',
    state: null,
    problem: null,
    notes: null,
    claims: null,
    clock: null,
    leaderboard: null,
  }
  renderClusterPage(page as unknown as HTMLElement, cluster as OpenCluster, state(sessions), 'me', [own('api'), own('rig')], {
    back() {},
    putIn: (session, delivery) => putIn.push([session.id, delivery]),
    takeOut() {},
  })
  const rows = page.all(node => node.className === 'session')
  const row = (name: string) => rows.find(node => node.all(child => child.tagName === 'strong')[0]?.text === name)
  const buttons = (name: string) => row(name)?.all(node => node.tagName === 'button') ?? []
  return { row, buttons, putIn }
}

test('your session set to live that skips permission prompts says it gets digests, with Live anyway one click away', () => {
  const { row, buttons, putIn } = render([member('me', 'api', TURNED), member('ana', 'rig', TURNED)])
  expect(row('api')?.text).toContain('Live → digest: skips permission prompts')
  expect(buttons('api').map(button => button.text)).toEqual(['Live anyway', 'Take out'])
  buttons('api')[0]?.onclick?.()
  expect(putIn).toEqual([['api', 'anyway']])
  // Another member's session: nothing to choose for it.
  expect(row('rig')?.text).not.toContain('Live → digest')
  expect(buttons('rig')).toEqual([])
})

test('a codex nothing drives says it reads posts at its next prompt, with no Live anyway', () => {
  const { row, buttons } = render([member('me', 'api', { tool: 'codex', delivery: 'digest' })])
  expect(row('api')?.text).toContain('Live → digest: a codex started without tonton codex reads posts at its next prompt')
  expect(buttons('api').map(button => button.text)).toEqual(['Take out'])
})

test('an older agent, a session that asks, or a choice other than live shows what it showed before', () => {
  expect(render([member('me', 'api', {})]).row('api')?.text).not.toContain('Live → digest')
  expect(render([member('me', 'api', { delivery: 'live' })]).row('api')?.text).not.toContain('Live → digest')
  saved.set('tonton.clusterDelivery', JSON.stringify({ 'cluster00001/api': 'anyway' }))
  expect(
    render([member('me', 'api', TURNED)])
      .buttons('api')
      .map(button => button.text),
  ).toEqual(['Take out'])
  saved.set('tonton.clusterDelivery', JSON.stringify({ 'cluster00001/api': 'digest' }))
  expect(render([member('me', 'api', TURNED)]).row('api')?.text).not.toContain('Live → digest')
})
