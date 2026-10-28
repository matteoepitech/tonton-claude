import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { paths } from '../src/config'
import { log } from '../src/log'

test("agent code run by a test writes to a temporary home, never to the developer's ~/.tonton", () => {
  expect(paths.home).not.toBe(join(homedir(), '.tonton'))
  log('a line from the tests')
  expect(readFileSync(paths.log, 'utf8')).toContain('a line from the tests')
  expect(existsSync(paths.log)).toBe(true)
})
