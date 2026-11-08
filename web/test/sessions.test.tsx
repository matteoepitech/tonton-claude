// The website's session list and chat header with sessions of several tools: each row marks its tool when the list
// mixes them, the search finds a tool by name ("codex"), and the header names a tool other than Claude Code.
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ClientState, Session } from '../../shared'
import { profileOf } from '../site/clusters/model'
import { ChatHeader } from '../site/sessions/chat'
import { SessionGroups } from '../site/sessions/list'

const session = (id: string, fields: Partial<Session>): Session => ({
  id,
  machineId: 'm1',
  machine: 'Mac',
  platform: 'darwin',
  cwd: `/code/${id}`,
  project: id,
  name: null,
  title: null,
  status: 'idle',
  statusText: null,
  agentOnline: true,
  canChat: true,
  pendingPermissions: [],
  costUSD: null,
  tokens: null,
  context: null,
  startedAt: 0,
  lastActivity: 0,
  lastMessage: null,
  fiveHourLimit: null,
  sevenDayLimit: null,
  terminal: false,
  commands: [],
  model: null,
  tool: null,
  branch: null,
  tasks: null,
  ...fields,
})

const state = (sessions: Session[]) => ({ connection: 'connected', sessions, selectedId: null }) as unknown as ClientState

const list = (sessions: Session[], query = '', folded: string[] = []) =>
  renderToStaticMarkup(<SessionGroups state={state(sessions)} folded={new Set(folded)} onPick={() => {}} onFold={() => {}} query={query} />)

const mixed = [session('api', {}), session('shop', { tool: 'codex', machine: 'PC' }), session('docs', { tool: 'opencode' })]

test('with several tools, each row marks the one that runs it', () => {
  const html = list(mixed)
  expect(html).toContain('aria-label="Codex"')
  expect(html).toContain('aria-label="OpenCode"')
  expect(html).toContain('aria-label="Claude Code"')
  expect(list([session('api', {}), session('web', { tool: 'claude' })])).not.toContain('aria-label="Claude Code"')
})

test('searching "codex" lists the Codex sessions, folded or not', () => {
  expect(list(mixed, '', ['machine:PC'])).not.toContain('>shop<')
  const html = list(mixed, 'codex', ['machine:PC'])
  expect(html).toContain('>shop<')
  expect(html).not.toContain('>api<')
  expect(html).not.toContain('>docs<')
  expect(list(mixed, 'CODEX')).toContain('>shop<')
  expect(list(mixed, 'nothing like it')).toContain('No session matches “nothing like it”.')
})

test('the header says the tool when it is not Claude Code', () => {
  const header = (fields: Partial<Session>) => renderToStaticMarkup(<ChatHeader session={session('shop', fields)} client={null} />)
  expect(header({ tool: 'codex', branch: 'main' })).toContain('Mac · ⎇ main · Codex')
  expect(header({ tool: 'opencode' })).toContain('Mac · OpenCode')
  expect(header({})).toMatch(/<small[^>]*>Mac<\/small>/)
})

test('a Codex session joins a cluster as Codex, not as Claude Code', () => {
  expect(profileOf(session('shop', { tool: 'codex' })).tool).toBe('codex')
  expect(profileOf(session('docs', { tool: 'opencode' })).tool).toBe('opencode')
  expect(profileOf(session('api', {})).tool).toBe('claude')
  expect(profileOf(session('odd', { tool: 'aider' })).tool).toBe('claude')
})
