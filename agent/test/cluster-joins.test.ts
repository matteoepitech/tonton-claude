// How a session takes cluster posts outside the MCP channel, and how the machine's owner puts sessions in from the
// machine: the digest the UserPromptSubmit hook hands Claude, what the hooks tell the channel, the rules `tonton cluster`
// writes and what each channel does with them.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ClusterVault,
  clusterDeliveryProfile,
  decodeClusterSessionProfile,
  grantClusterKey,
  newClusterKey,
  openClusterSessionOrder,
  sealClusterSessionOrder,
} from '../../shared/cluster'
import type { ClusterSummary } from '../../shared/cluster-protocol'
import { newAccountKey } from '../../shared/crypto'
import type { AgentMessage } from '../../shared/protocol'
import { DIGEST_SIZE, deferClusterPost, forgetClusterPosts, takeClusterDigest } from '../src/channel/cluster-digest'
import { ClusterAutoJoin, inFolder, readClusterJoins, writeClusterJoins } from '../src/channel/cluster-joins'
import { SessionClusters } from '../src/channel/clusters'
import { hookState } from '../src/channel/session-link'
import { parseClusterArgs, runClusterCommand } from '../src/cluster-cli'
import type { AgentConfig } from '../src/config'

const AGENT = join(import.meta.dir, '../src/main.ts')
const home = process.env.TONTON_HOME as string
const dir = mkdtempSync(join(tmpdir(), 'tonton-cluster-joins-'))
const accountKey = newAccountKey()
const clusterKey = newClusterKey()
const CLUSTER = 'cluster12345'

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('the digest at the next prompt', () => {
  test('posts wait in order, are taken once, and the oldest go past the limit', () => {
    deferClusterPost('ses_d1', CLUSTER, '<cluster kind="message" from="Ana">one</cluster>')
    deferClusterPost('ses_d1', CLUSTER, '<cluster kind="message" from="Ana">two</cluster>')
    const digest = takeClusterDigest('ses_d1') ?? ''
    expect(digest).toStartWith('Cluster posts since your last prompt (2).')
    expect(digest).toContain('not from your user')
    expect(digest.indexOf('one')).toBeLessThan(digest.indexOf('two'))
    expect(takeClusterDigest('ses_d1')).toBeNull()

    for (let i = 0; i < DIGEST_SIZE + 3; i++) deferClusterPost('ses_d1', CLUSTER, `post ${i}`)
    const full = takeClusterDigest('ses_d1') ?? ''
    expect(full).toContain(`(${DIGEST_SIZE + 3})`)
    expect(full).toContain('3 older posts left out: cluster_inbox lists them.')
    expect(full).not.toContain('post 2\n')
    expect(full).toContain(`post ${DIGEST_SIZE + 2}`)
  })

  test("a cluster the session left takes its posts with it, and nobody else's", () => {
    deferClusterPost('ses_d2', CLUSTER, 'from the cluster it left')
    deferClusterPost('ses_d2', 'othercluster', 'from another one')
    forgetClusterPosts('ses_d2', CLUSTER)
    const digest = takeClusterDigest('ses_d2') ?? ''
    expect(digest).toContain('from another one')
    expect(digest).not.toContain('from the cluster it left')
  })

  test('the UserPromptSubmit hook hands it to Claude, and tells the channel the turn started and the mode', async () => {
    deferClusterPost('ses_hook', CLUSTER, '<cluster kind="ask" from="Ana">Ready?</cluster>')
    const run = (event: object) =>
      Bun.spawn([process.execPath, AGENT, 'hook'], {
        env: { ...process.env, TONTON_HOME: home, TONTON_SERVICE: 'off' },
        stdin: new Blob([JSON.stringify(event)]),
        stdout: 'pipe',
      })
    const prompt = run({ hook_event_name: 'UserPromptSubmit', session_id: 'ses_hook', permission_mode: 'bypassPermissions', prompt: 'go' })
    const output = JSON.parse(await new Response(prompt.stdout).text())
    expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
    expect(output.hookSpecificOutput.additionalContext).toContain('Ready?')
    // The hook's parent is this process, as the channel's is Claude Code.
    const link = join(home, 'run', `${process.pid}.json`)
    expect(hookState(link)).toEqual({ busy: true, skipsPrompts: true })
    // Nothing waits: the hook prints nothing, as before clusters.
    const again = run({ hook_event_name: 'UserPromptSubmit', session_id: 'ses_hook', permission_mode: 'default' })
    expect(await new Response(again.stdout).text()).toBe('')
    expect(hookState(link)).toEqual({ busy: true, skipsPrompts: false })
    await run({ hook_event_name: 'Notification', session_id: 'ses_hook', notification_type: 'permission_prompt' }).exited
    expect(hookState(link).busy).toBe(true)
    await run({ hook_event_name: 'Stop', session_id: 'ses_hook' }).exited
    expect(hookState(link).busy).toBe(false)
    expect(hookState(join(dir, 'missing.json'))).toEqual({ busy: false, skipsPrompts: false })
  })
})

describe('folders', () => {
  test('a folder holds itself and what is below it, nothing beside it', () => {
    expect(inFolder('/home/me/jam', '/home/me/jam')).toBe(true)
    expect(inFolder('/home/me/jam/Source/Hero', '/home/me/jam')).toBe(true)
    expect(inFolder('/home/me/jam/', '/home/me/jam')).toBe(true)
    expect(inFolder('/home/me/jam2', '/home/me/jam')).toBe(false)
    expect(inFolder('/home/me', '/home/me/jam')).toBe(false)
    expect(inFolder('/home/me/..jam', '/home/me')).toBe(true)
  })
})

const config = (server: string): AgentConfig => ({
  server,
  account: 'acc_me',
  machineId: 'm1',
  token: 'tm_machine',
  key: accountKey,
  machine: 'mac',
})

describe('a channel and the rules of its machine', () => {
  let sent: AgentMessage[]
  let clusters: SessionClusters
  const post = (build: () => Promise<AgentMessage | null>) => {
    void build().then(message => message && sent.push(message))
  }
  const flush = () => Bun.sleep(30)
  /** No relay to ask: the key of the rule is used. */
  const offline = { list: () => Promise.reject(new Error('offline')), members: () => Promise.resolve([]) } as never

  beforeEach(async () => {
    sent = []
    clusters = new SessionClusters(() => 'ses_rule', accountKey, post)
    rmSync(join(home, 'cluster-joins.json'), { force: true })
  })

  const autoJoin = (cwd: string) =>
    new ClusterAutoJoin(
      config('http://127.0.0.1:9'),
      () => 'ses_rule',
      () => cwd,
      clusters,
      post,
      order => ({ tool: 'claude', project: 'jam', ...clusterDeliveryProfile(order, false) }),
      offline,
    )

  test('a session in a folder that joins seals its own order, once', async () => {
    const issuedAt = new Date().toISOString()
    await writeClusterJoins(accountKey, {
      joins: [{ clusterId: CLUSTER, name: 'Jam', key: clusterKey, version: 1, folder: '/home/me/jam', delivery: 'digest', issuedAt }],
      leaves: [],
    })
    const joining = autoJoin('/home/me/jam/Source')
    await joining.poll()
    await flush()
    expect(sent).toHaveLength(1)
    const message = sent[0]
    if (message?.t !== 'cluster_join_session') throw new Error('no join')
    expect(message).toMatchObject({ sessionId: 'ses_rule', clusterId: CLUSTER })
    expect(await openClusterSessionOrder(accountKey, message.order, 'ses_rule', CLUSTER)).toMatchObject({
      key: clusterKey,
      version: 1,
      delivery: 'digest',
    })
    // The profile is made for the order: it says how the session takes posts.
    expect(await new ClusterVault(clusterKey).read(message.profile, decodeClusterSessionProfile)).toEqual({
      tool: 'claude',
      project: 'jam',
      delivery: 'digest',
    })
    // Read again, the same rule does nothing: a session its owner took out from the app stays out.
    await joining.poll(true)
    await flush()
    expect(sent).toHaveLength(1)
    // Elsewhere, nothing.
    await autoJoin('/home/me/other').poll()
    await flush()
    expect(sent).toHaveLength(1)
  })

  test('a leave takes out the sessions it names that joined before it', async () => {
    clusters.receive(
      CLUSTER,
      await sealClusterSessionOrder(accountKey, { clusterId: CLUSTER, sessionId: 'ses_rule', key: clusterKey, version: 1 }),
    )
    await flush()
    sent = []
    await writeClusterJoins(accountKey, { joins: [], leaves: [{ folder: '/home/me/jam', issuedAt: new Date().toISOString() }] })
    await autoJoin('/home/me/jam').poll()
    await flush()
    expect(sent).toEqual([{ t: 'cluster_leave_session', sessionId: 'ses_rule', clusterId: CLUSTER }])
  })

  test('rules not sealed with the account key are no rules', async () => {
    writeFileSync(join(home, 'cluster-joins.json'), JSON.stringify({ v: 1, blob: 'forged' }))
    expect(await readClusterJoins(accountKey)).toEqual({ joins: [], leaves: [] })
    mkdirSync(home, { recursive: true })
    await writeClusterJoins(newAccountKey(), {
      joins: [{ clusterId: CLUSTER, key: clusterKey, version: 1, session: 'ses_rule', issuedAt: new Date().toISOString() }],
      leaves: [],
    })
    await autoJoin('/anywhere').poll()
    await flush()
    expect(sent).toEqual([])
  })
})

describe('tonton cluster', () => {
  test('its options', () => {
    expect(parseClusterArgs(['Jam', './game', '--digest'])).toEqual({
      positional: ['Jam', './game'],
      delivery: 'digest',
      liveWithoutPrompts: false,
    })
    expect(parseClusterArgs(['Jam', '--session', 'ses_1', '--live-without-prompts'])).toMatchObject({
      session: 'ses_1',
      liveWithoutPrompts: true,
    })
    expect(parseClusterArgs(['--live', '--muted'])).toBe('Choose one of --live, --digest and --muted.')
    expect(parseClusterArgs(['--session'])).toBe('--session needs a session id.')
    expect(parseClusterArgs(['--force'])).toBe('Unknown option --force.')
  })

  test('join and leave a folder, with the cluster named as the relay lists it for the machine', async () => {
    const summary: ClusterSummary = {
      id: CLUSTER,
      role: 'member',
      createdAt: 'now',
      keyVersion: 1,
      info: await new ClusterVault(clusterKey).seal({ name: 'Jam' }),
      key: await grantClusterKey(accountKey, CLUSTER, clusterKey, 1),
      members: 2,
      secret: null,
      wraps: [],
    }
    const asked: string[] = []
    const server = Bun.serve({
      port: 0,
      fetch: request => {
        const url = new URL(request.url)
        asked.push(`${url.pathname} ${request.headers.get('authorization')}`)
        if (url.pathname === '/api/agent/clusters') return Response.json([summary])
        if (url.pathname === `/api/agent/clusters/${CLUSTER}/members`) return Response.json([])
        return new Response('{}', { status: 404 })
      },
    })
    try {
      const relay = config(`http://127.0.0.1:${server.port}`)
      const joined = await runClusterCommand(['join', 'jam', 'game', '--digest'], relay, '/home/me')
      expect(joined).toEqual({
        ok: true,
        text: 'The sessions of /home/me/game join Jam: those running now, and every new one started there (digest).',
      })
      expect(asked).toContain('/api/agent/clusters Bearer tm_machine')
      const rules = await readClusterJoins(accountKey)
      expect(rules.joins).toMatchObject([
        { clusterId: CLUSTER, name: 'Jam', key: clusterKey, version: 1, folder: '/home/me/game', delivery: 'digest' },
      ])
      expect(readFileSync(join(home, 'cluster-joins.json'), 'utf8')).not.toContain(clusterKey)

      expect((await runClusterCommand(['list'], relay)).text).toBe(`Jam (${CLUSTER}, member)\n  joined by /home/me/game (digest)`)
      expect(await runClusterCommand(['join', 'nope'], relay)).toMatchObject({ ok: false })

      expect(await runClusterCommand(['leave', 'Jam', 'game'], relay, '/home/me')).toEqual({
        ok: true,
        text: 'The sessions of /home/me/game leave Jam.',
      })
      const after = await readClusterJoins(accountKey)
      expect(after.joins).toEqual([])
      expect(after.leaves).toMatchObject([{ clusterId: CLUSTER, folder: '/home/me/game' }])
      // A folder alone: every cluster.
      expect((await runClusterCommand(['leave', '/home/me/game'], relay)).text).toBe('The sessions of /home/me/game leave every cluster.')
    } finally {
      server.stop(true)
    }
  })
})
