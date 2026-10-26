// The client core must run in browsers: `tsc -p shared` checks it against the DOM types only, and this bundles it the way a
// web app would and looks for what browsers do not have.
import { expect, test } from 'bun:test'
import { join } from 'node:path'

test('the client core bundles for browsers without Node APIs', async () => {
  const result = await Bun.build({ entrypoints: [join(import.meta.dir, '../index.ts')], target: 'browser' })
  expect(result.success).toBe(true)
  const code = await result.outputs[0].text()
  expect(code).toContain('tonton/v1')
  for (const nodeOnly of [/\bBuffer\b/, /\bprocess\./, /\brequire\(/, /from ["']node:/, /\bBun\./]) expect(code).not.toMatch(nodeOnly)
})
