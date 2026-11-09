// The island's session list (web/views.ts, renderList), on a small stand-in for the DOM: rows mark their tool when the
// list mixes tools, the search finds "codex", and the search field outlives the renders it causes, so typing keeps going.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { ClientState, Session } from '../../shared'
import { FakeElement, type FakeInput, useFakeDom } from './fake-dom'

let renderList: typeof import('../views').renderList

let removeDom = () => {}

beforeAll(async () => {
  removeDom = useFakeDom()
  ;({ renderList } = await import('../views'))
})

// Other test files run in the same process, without a DOM.
afterAll(() => removeDom())

const session = (id: string, machine: string, tool: string | null): Session =>
  ({ id, machine, project: id, name: null, title: null, tool, status: 'idle', pendingPermissions: [], tasks: null }) as unknown as Session

const state = (sessions: Session[]) => ({ connection: 'connected', sessions, selectedId: null }) as unknown as ClientState

const mixed = [session('api', 'PC', null), session('shop', 'Mac', 'codex'), session('docs', 'Mac', 'opencode')]

function render(sessions: Session[], folded: string[] = []) {
  const list = new FakeElement('div')
  const draw = () => renderList(list as unknown as HTMLElement, state(sessions), () => {}, { folded: new Set(folded), toggle() {} })
  draw()
  const rows = () => list.all(node => node.className.split(' ').includes('session'))
  const field = () => list.firstElementChild as FakeInput
  const type = (text: string) => {
    field().value = text
    field().oninput?.()
  }
  return { list, rows, field, type, draw }
}

// The search is kept across renders, like a draft: each test starts without one.
afterEach(() => render(mixed).type(''))

test('with several tools, each row marks the one that runs it', () => {
  const { rows } = render(mixed)
  const marks = rows().map(row => row.all(node => node.className === 'tool-mark')[0]?.title)
  expect(marks).toEqual(['Claude Code', 'Codex', 'OpenCode'])
  expect(rows()[1].text).toContain('>_shop')
  const alone = render([session('api', 'PC', null), session('web', 'PC', 'claude')])
  expect(alone.rows().flatMap(row => row.all(node => node.className === 'tool-mark'))).toEqual([])
})

test('searching "codex" lists the Codex sessions, even on a folded machine, in the same field', () => {
  const { rows, field, type } = render(mixed, ['machine:Mac'])
  expect(rows().map(row => row.text)).toEqual(['✳apiDone'])
  const before = field()
  expect(before.placeholder).toBe('Search sessions')
  type('codex')
  expect(field()).toBe(before)
  expect(rows().map(row => row.text)).toEqual(['>_shopDone'])
  type('nothing like it')
  expect(rows()).toEqual([])
  expect(render(mixed).list.text).toContain('No session matches “nothing like it”.')
})

test('without sessions there is nothing to search', () => {
  const { list } = render([])
  expect(list.firstElementChild?.tagName).toBe('p')
  expect(list.text).toBe('No sessions yet.')
})
