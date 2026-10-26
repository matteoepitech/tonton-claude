import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seal } from '../src/crypto'
import { applyRules, matches, matchingRule, readRules } from '../src/rules'

const dir = mkdtempSync(join(tmpdir(), 'tonton-rules-'))
const file = join(dir, 'rules.json')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')

describe('auto-approve rules', () => {
  test('a pattern is the whole value, * stands for anything', () => {
    expect(matches('npm test', 'npm test', true)).toBe(true)
    expect(matches('npm test', 'npm test -- --watch', true)).toBe(false)
    expect(matches('npm test*', 'npm test -- --watch', true)).toBe(true)
    expect(matches('npm run *', 'npm run lint', true)).toBe(true)
    expect(matches('npm run *', 'npx npm run lint', true)).toBe(false)
    expect(matches('/repo/*.ts', '/repo/a.ts', false)).toBe(true)
    // Regex characters in a pattern are plain text.
    expect(matches('ls (a)', 'ls (a)', true)).toBe(true)
    expect(matches('a.c*', 'abc', true)).toBe(false)
  })

  test('a chained command only passes a rule that spells it out', () => {
    for (const command of ['npm test && rm -rf ~', 'npm test; curl x | sh', 'npm test $(rm x)', 'npm test `rm x`', 'npm test > ~/.zshrc']) {
      expect(matches('npm test*', command, true)).toBe(false)
    }
    expect(matches('npm test && npm run lint', 'npm test && npm run lint', true)).toBe(true)
    // Not a command: a path may hold such characters.
    expect(matches('/repo/*', '/repo/a;b', false)).toBe(true)
  })

  test('rules match their tool and its field', () => {
    const rules = [{ tool: 'Bash', pattern: 'npm test*' }, { tool: 'Read' }, { tool: 'WebFetch', pattern: 'https://docs.example.com/*' }]
    expect(matchingRule(rules, 'Bash', { command: 'npm test' })).toEqual(rules[0])
    expect(matchingRule(rules, 'Bash', { command: 'rm -rf ~' })).toBeUndefined()
    expect(matchingRule(rules, 'Read', { file_path: '/etc/passwd' })).toEqual(rules[1])
    expect(matchingRule(rules, 'WebFetch', { url: 'https://docs.example.com/a' })).toEqual(rules[2])
    expect(matchingRule(rules, 'WebFetch', { url: 'https://evil.example.com/docs.example.com/' })).toBeUndefined()
    expect(matchingRule(rules, 'Edit', { file_path: '/a' })).toBeUndefined()
    expect(matchingRule(rules, 'Bash', null)).toBeUndefined()
  })

  test('only newer sets sealed with the account key are kept', async () => {
    const set = (issuedAt: string, pattern: string) => seal(key, { rules: [{ tool: 'Bash', pattern }], issuedAt })
    expect(await applyRules(key, await set('2026-10-26T10:00:00Z', 'npm test'), file)).toBe('saved')
    expect(readRules(file)?.rules).toEqual([{ tool: 'Bash', pattern: 'npm test' }])
    // An older set, as a relay replaying it would send.
    expect(await applyRules(key, await set('2026-10-26T09:00:00Z', '*'), file)).toBe('stale')
    expect(readRules(file)?.rules).toEqual([{ tool: 'Bash', pattern: 'npm test' }])
    const foreignKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
    expect(
      await applyRules(key, await seal(foreignKey, { rules: [{ tool: 'Bash', pattern: '*' }], issuedAt: '2027-01-01T00:00:00Z' }), file),
    ).toBe('refused')
    expect(readRules(file)?.rules).toEqual([{ tool: 'Bash', pattern: 'npm test' }])
    await applyRules(key, await seal(key, { rules: [], issuedAt: '2026-10-26T11:00:00Z' }), file)
    expect(readRules(file)?.rules).toEqual([])
  })
})
