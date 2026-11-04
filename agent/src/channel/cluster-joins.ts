// The clusters this machine's owner put sessions in from the machine itself (docs/cluster.md, Putting a session in):
// `tonton cluster join` writes a rule, for one session or for a folder, sealed with the account key, and each channel reads
// the rules when it starts and when they change. A rule that names its session, or a folder its session runs in, makes
// the channel seal its own order with the account key and send it: the relay takes it from the session's own socket only,
// and answers with the order like one from the app. Nothing here reaches another machine or another account's session.

import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ClusterVault, openClusterGrant, sealClusterSessionOrder } from '../../../shared/cluster'
import { ClusterApi, resolveClusterKeyring } from '../../../shared/cluster-api'
import type { ClusterDelivery, ClusterSessionProfile, ClusterSummary } from '../../../shared/cluster-protocol'
import { open, seal } from '../../../shared/crypto'
import { PoolKeyring } from '../../../shared/pool-keys'
import type { AgentMessage } from '../../../shared/protocol'
import { type AgentConfig, paths } from '../config'
import { log } from '../log'
import type { SessionClusters } from './clusters'

type Post = (build: () => Promise<AgentMessage | null>) => void

const POLL_MS = 2000
/** A leave is kept this long, for the sessions that were in the cluster when it was written. */
const LEAVE_KEPT_MS = 7 * 24 * 3_600_000

export interface ClusterJoinRule {
  clusterId: string
  /** The cluster's name, as the command showed it. */
  name?: string
  /** The cluster key when the rule was written: the channel asks the relay for a newer one first. */
  key: string
  version: number
  /** Every session that runs in this folder or below it, now and later. */
  folder?: string
  /** One session. */
  session?: string
  delivery?: ClusterDelivery
  liveWithoutPrompts?: boolean
  issuedAt: string
}

export interface ClusterLeaveRule {
  /** Missing: every cluster. */
  clusterId?: string
  folder?: string
  session?: string
  issuedAt: string
}

export interface ClusterJoinRules {
  joins: ClusterJoinRule[]
  leaves: ClusterLeaveRule[]
}

const rulesFile = () => join(paths.home, 'cluster-joins.json')

/** The rules, opened with the account key; none when the file is missing or was not sealed with it. */
export async function readClusterJoins(accountKey: string): Promise<ClusterJoinRules> {
  try {
    const sealed = JSON.parse(readFileSync(rulesFile(), 'utf8')) as { blob?: unknown }
    if (typeof sealed.blob !== 'string') return { joins: [], leaves: [] }
    const rules = await open<Partial<ClusterJoinRules>>(accountKey, sealed.blob)
    return {
      joins: Array.isArray(rules.joins) ? rules.joins.filter(isJoin) : [],
      leaves: Array.isArray(rules.leaves) ? rules.leaves.filter(isLeave) : [],
    }
  } catch {
    return { joins: [], leaves: [] }
  }
}

export async function writeClusterJoins(accountKey: string, rules: ClusterJoinRules, now = Date.now()) {
  const leaves = rules.leaves.filter(leave => now - Date.parse(leave.issuedAt) < LEAVE_KEPT_MS)
  const blob = await seal(accountKey, { joins: rules.joins, leaves })
  writeFileSync(rulesFile(), JSON.stringify({ v: 1, blob }), { mode: 0o600 })
}

const isText = (value: unknown): value is string => typeof value === 'string'
const isJoin = (value: unknown): value is ClusterJoinRule => {
  const rule = value as Partial<ClusterJoinRule> | null
  return Boolean(rule && isText(rule.clusterId) && isText(rule.key) && typeof rule.version === 'number' && isText(rule.issuedAt))
}
const isLeave = (value: unknown): value is ClusterLeaveRule => {
  const rule = value as Partial<ClusterLeaveRule> | null
  return Boolean(rule && isText(rule.issuedAt) && (rule.clusterId === undefined || isText(rule.clusterId)))
}

/** True when `cwd` is `folder` or below it. */
export function inFolder(cwd: string, folder: string): boolean {
  const fold = (path: string) =>
    process.platform === 'win32' || process.platform === 'darwin' ? resolve(path).toLowerCase() : resolve(path)
  const path = relative(fold(folder), fold(cwd))
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

/** A rule is for a session by its id, or by the folder it runs in. */
const matches = (rule: { folder?: string; session?: string }, sessionId: string, cwd: string) =>
  rule.session ? rule.session === sessionId : rule.folder ? inFolder(cwd, rule.folder) : false

/** The latest version of a cluster's key this account holds, from the relay's machine routes. */
export async function latestClusterKey(
  config: AgentConfig,
  summary: ClusterSummary,
  api = new ClusterApi({ relay: config.server, token: config.token, agent: true }),
): Promise<PoolKeyring | null> {
  if (config.account) {
    const members = await api.members(summary.id).catch(() => [])
    const resolved = await resolveClusterKeyring(config.key, config.account, summary, members)
    if (resolved) return resolved.keyring
  }
  const grant = await openClusterGrant(config.key, summary.key, summary.id)
  return grant ? new PoolKeyring(grant.key, grant.version) : null
}

/** In a session's channel: applies the rules that are for it. */
export class ClusterAutoJoin {
  private timer: ReturnType<typeof setInterval> | null = null
  private seenMtime = -1
  /** Rules already applied, by cluster and time: a session the owner took out from the app is not put back in. */
  private readonly applied = new Set<string>()

  constructor(
    private readonly config: AgentConfig,
    private readonly sessionId: () => string,
    private readonly cwd: () => string,
    private readonly clusters: SessionClusters,
    private readonly post: Post,
    /** How the session shows in the cluster, to seal with the order. */
    private readonly profile: () => ClusterSessionProfile,
    private readonly api = new ClusterApi({ relay: config.server, token: config.token, agent: true }),
  ) {}

  start() {
    void this.poll()
    this.timer = setInterval(() => void this.poll(), POLL_MS)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  /** Reads the rules again when the file changed. Exposed for the tests. */
  async poll(force = false) {
    let mtime: number
    try {
      mtime = statSync(rulesFile()).mtimeMs
    } catch {
      return
    }
    if (!force && mtime === this.seenMtime) return
    this.seenMtime = mtime
    await this.apply(await readClusterJoins(this.config.key))
  }

  private async apply(rules: ClusterJoinRules) {
    const sessionId = this.sessionId()
    const cwd = this.cwd()
    for (const leave of rules.leaves) {
      if (!matches(leave, sessionId, cwd)) continue
      for (const clusterId of this.clusters.ids()) {
        if (leave.clusterId && leave.clusterId !== clusterId) continue
        const order = this.clusters.order(clusterId)
        const mark = `leave/${clusterId}/${leave.issuedAt}`
        if (!order || order.issuedAt > leave.issuedAt || this.applied.has(mark)) continue
        this.applied.add(mark)
        log('session leaves a cluster, as the machine owner asked', { cluster: clusterId })
        this.post(async () => ({ t: 'cluster_leave_session', sessionId, clusterId }))
      }
    }
    for (const rule of rules.joins) {
      if (!matches(rule, sessionId, cwd)) continue
      const mark = `join/${rule.clusterId}/${rule.issuedAt}`
      if (this.applied.has(mark)) continue
      this.applied.add(mark)
      // Already in it by a newer order, from the app or an earlier rule.
      if ((this.clusters.order(rule.clusterId)?.issuedAt ?? '') > rule.issuedAt) continue
      await this.join(rule, sessionId)
    }
  }

  private async join(rule: ClusterJoinRule, sessionId: string) {
    let keyring = new PoolKeyring(rule.key, rule.version)
    try {
      const summary = (await this.api.list()).find(cluster => cluster.id === rule.clusterId)
      if (!summary) {
        log('cluster rule skipped: the account is not in that cluster any more', { cluster: rule.clusterId })
        return
      }
      keyring = (await latestClusterKey(this.config, summary, this.api)) ?? keyring
    } catch (error) {
      // An older relay, or none right now: the key the rule holds still opens the cluster.
      log('cluster rule: the relay did not list the clusters, using the key of the rule', String(error))
    }
    const version = keyring.version
    const key = keyring.key(version) as string
    const order = {
      clusterId: rule.clusterId,
      sessionId,
      key,
      version,
      ...(rule.delivery ? { delivery: rule.delivery } : {}),
      ...(rule.liveWithoutPrompts ? { liveWithoutPrompts: true } : {}),
    }
    log('session joins a cluster, as the machine owner asked', { cluster: rule.clusterId })
    this.post(async () => ({
      t: 'cluster_join_session',
      sessionId,
      clusterId: rule.clusterId,
      order: await sealClusterSessionOrder(this.config.key, order),
      profile: await new ClusterVault(keyring).seal(this.profile()),
    }))
  }
}
