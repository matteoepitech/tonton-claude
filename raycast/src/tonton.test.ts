import { describe, expect, test } from 'bun:test'
import { parseReplies, parseSessions, scriptError, scripts, sorted } from './tonton'

describe('raycast extension', () => {
  test('reads the sessions the app returns and skips what it does not know', () => {
    const output = JSON.stringify([
      { session: 's1', project: 'api', machine: 'PC', status: 'working', title: 'Fix login', folder: '/code/api', cost: '1.20' },
      { session: 's2', project: 'web', status: 'something-new' },
      { project: 'no id' },
      'junk',
    ])
    expect(parseSessions(output)).toEqual([
      { session: 's1', project: 'api', machine: 'PC', status: 'working', title: 'Fix login', folder: '/code/api', cost: '1.20' },
      { session: 's2', project: 'web', machine: '', status: 'offline', title: '', folder: '' },
    ])
    expect(parseSessions('')).toEqual([])
    expect(parseSessions('{}')).toEqual([])
  })

  test('keeps the quick replies that have text', () => {
    expect(parseReplies(JSON.stringify(['Yes', ' ', 3, 'Continue']))).toEqual(['Yes', 'Continue'])
  })

  test('shows the app message without osascript around it', () => {
    const error = new Error(
      "Command failed\n0:1: execution error: Error: Error: Scripts can't send messages. Turn it on in Tonton Claude › Settings › General. (-10000)",
    )
    expect(scriptError(error)).toBe("Scripts can't send messages. Turn it on in Tonton Claude › Settings › General.")
    expect(scriptError(new Error('execution error: Error: Tonton Claude is not running. (-2700)'))).toBe('Tonton Claude is not running.')
    expect(scriptError(new Error("execution error: Error: Error: Application can't be found. (-2700)"))).toBe(
      'Tonton Claude is not installed or not running.',
    )
  })

  test('puts the sessions that need the user first', () => {
    const base = { machine: '', title: '', folder: '' }
    const order = sorted([
      { ...base, session: 'a', project: 'a', status: 'idle' },
      { ...base, session: 'b', project: 'b', status: 'permission' },
      { ...base, session: 'c', project: 'c', status: 'working' },
    ]).map(s => s.session)
    expect(order).toEqual(['b', 'c', 'a'])
  })

  test('never puts the message or the session inside a script', () => {
    expect(scripts.send).toContain('argv[0]')
    expect(scripts.send).toContain('argv[1]')
  })
})
