import { expect, test } from 'bun:test'
import { changedFiles, shownPath } from '../changed-files'
import type { Entry } from '../protocol'

const call = (id: string, name: string, summary: string, edits?: { oldText: string; newText: string }[], ts = 't'): Entry => ({
  id,
  ts,
  kind: 'tool',
  toolUseId: id,
  name,
  summary,
  ...(edits ? { edits } : {}),
})
const result = (id: string, isError = false): Entry => ({ id: `${id}:r`, ts: 't', kind: 'tool_result', toolUseId: id, text: '', isError })

test('files come most recently changed first, failed calls add no diff', () => {
  const first = { oldText: 'a', newText: 'b' }
  const files = changedFiles([
    call('e1', 'Edit', '/srv/api/app.ts', [first], '1'),
    result('e1'),
    call('w1', 'Write', '/srv/api/README.md', undefined, '2'),
    result('w1'),
    call('r1', 'Read', '/srv/api/other.ts'),
    call('e2', 'Edit', '/srv/api/app.ts', [{ oldText: 'x', newText: 'y' }], '3'),
    result('e2', true),
    call('c1', 'Edit', '/cut/short…'),
    call('w2', 'Write', 'C:\\code\\main.go'),
  ])
  expect(files.map(f => f.path)).toEqual(['C:\\code\\main.go', '/srv/api/app.ts', '/srv/api/README.md'])
  expect(files[1]).toMatchObject({ name: 'app.ts', edits: [first], changes: 1, lastFailed: true, lastChange: '3', written: false })
  expect(files[2]).toMatchObject({ written: true, edits: [], changes: 1 })
  expect(files[0].name).toBe('main.go')
})

test('paths show under the session folder', () => {
  expect(shownPath('/srv/api/src/app.ts', '/srv/api')).toBe('src/app.ts')
  expect(shownPath('/srv/api/src/app.ts', '/srv/api/')).toBe('src/app.ts')
  expect(shownPath('/srv/api/src/app.ts', '/srv/ap')).toBe('/srv/api/src/app.ts')
  expect(shownPath('C:\\code\\api\\main.go', 'C:\\code\\api')).toBe('main.go')
})
