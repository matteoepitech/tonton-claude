// A member's clusters as a client follows them: the list with each cluster's name, and the clusters it opened, live,
// with their shared documents opened. Each cluster's key comes from the member's own copy and the later versions
// wrapped for it (shared/pool-keys.ts, scoped with `clusterKeyScope`); a rotation brings a new snapshot, read with the
// new key. Apps never post (docs/cluster.md): what a client changes here is who is in, its own sessions and their
// delivery, its profile, and the clock. Every action the relay may refuse comes back as a problem to show.
// Used by the website and the island (web/site/clusters, web/views.ts).

import {
  type ClusterState,
  ClusterVault,
  clusterKeyScope,
  decodeClusterClaims,
  decodeClusterClock,
  decodeClusterInfo,
  decodeClusterNotes,
  openClusterGrant,
  sealClusterSessionOrder,
} from './cluster'
import { type ClusterApi, type ClusterInviteSummary, resolveClusterKeyring } from './cluster-api'
import {
  CLUSTER_LEADERBOARD,
  type ClusterLeaderboard,
  clusterHeroEntry,
  clusterHeroFrom,
  decodeClusterLeaderboard,
  sameClusterHero,
  sealedClusterLeaderboard,
  withClusterHero,
} from './cluster-heroes'
import { clusterInviteLink, parseClusterInvite } from './cluster-link'
import type {
  ClusterAppMessage,
  ClusterClaims,
  ClusterClock,
  ClusterDelivery,
  ClusterInfo,
  ClusterMemberProfile,
  ClusterMemberWire,
  ClusterNotes,
  ClusterRole,
  ClusterSessionProfile,
  ClusterSummary,
  ClusterUpdate,
} from './cluster-protocol'
import type { AccountKey } from './crypto'
import { needsRepublish, type PoolKeyring, type PoolMemberSecret, sealPoolMemberKey, sealPoolMemberSecret } from './pool-keys'
import type { RPGState } from './rpg'

/** The part of a relay client clusters need: `RelayClient` fits it. */
export interface ClusterLink {
  subscribeCluster(clusterId: string): void
  unsubscribeCluster(clusterId: string): void
  sendCluster(message: ClusterAppMessage): boolean
}

export interface ListedCluster {
  summary: ClusterSummary
  /** Null until opened, or when the cluster's name does not open with the keys this member holds. */
  info: ClusterInfo | null
}

/** The documents every client shows, opened: null while missing or when they don't open. */
export interface ClusterDocs {
  notes: ClusterNotes | null
  claims: ClusterClaims | null
  clock: ClusterClock | null
  /** The members who share their Tonton (shared/cluster-heroes.ts). */
  leaderboard: ClusterLeaderboard | null
}

export interface OpenCluster extends ClusterDocs {
  id: string
  role: ClusterRole
  /** Null until the first snapshot. */
  state: ClusterState | null
  /** The last thing the relay refused, to show once. */
  problem: string | null
}

interface Opened extends ClusterDocs {
  summary: ClusterSummary
  keyring: PoolKeyring | null
  secret: PoolMemberSecret | null
  vault: ClusterVault | null
  state: ClusterState | null
  problem: string | null
  /** What this member last asked here, its hero or null to leave: made again over a newer board after a conflict. */
  sharing?: { hero: RPGState | null }
}

export interface ClusterWatchOptions {
  api: ClusterApi
  accountKey: AccountKey
  /** This account's id: public keys are bound to it. */
  account: string
  relay: string
  link: ClusterLink
  onChange: () => void
}

/** What an owner chooses for one of its sessions in a cluster (docs/cluster.md, The rule). */
export interface ClusterSessionChoice {
  delivery: ClusterDelivery
  /** Live even though the session skips permission prompts: they get a digest otherwise. */
  liveWithoutPrompts?: boolean
}

const NO_DOCS: ClusterDocs = { notes: null, claims: null, clock: null, leaderboard: null }
/** What a relay from before clusters answers to every cluster route. */
export const CLUSTERS_UNSUPPORTED = "This relay doesn't know clusters yet: it needs updating."

export class ClusterWatch {
  private listed: ListedCluster[] = []
  private readonly opened = new Map<string, Opened>()
  /** Updates are opened one after the other, in the order they came. */
  private queue: Promise<void> = Promise.resolve()
  private listProblem: string | null = null
  private relayKnowsClusters = true

  constructor(private readonly options: ClusterWatchOptions) {}

  get clusters(): readonly ListedCluster[] {
    return this.listed
  }

  get problem(): string | null {
    return this.listProblem
  }

  /** False once the relay answered 404 to the cluster routes: it predates clusters. */
  get supported(): boolean {
    return this.relayKnowsClusters
  }

  cluster(clusterId: string): OpenCluster | null {
    const opened = this.opened.get(clusterId)
    if (!opened) return null
    const { summary, state, problem, notes, claims, clock, leaderboard } = opened
    return { id: clusterId, role: summary.role, state, problem, notes, claims, clock, leaderboard }
  }

  /** The clusters of the account, each with its name opened with the member's keys. */
  async refresh(): Promise<void> {
    try {
      const summaries = await this.options.api.list()
      this.listed = await Promise.all(summaries.map(async summary => ({ summary, info: await this.infoOf(summary) })))
      this.listProblem = null
      this.relayKnowsClusters = true
      for (const summary of summaries) {
        const opened = this.opened.get(summary.id)
        if (opened) opened.summary = summary
      }
    } catch (error) {
      this.listProblem = this.messageOf(error)
    }
    this.options.onChange()
  }

  /** Follows a cluster live: its snapshot, then each change. */
  open(clusterId: string) {
    const summary = this.listed.find(cluster => cluster.summary.id === clusterId)?.summary
    if (!summary || this.opened.has(clusterId)) return
    this.opened.set(clusterId, { summary, keyring: null, secret: null, vault: null, state: null, problem: null, ...NO_DOCS })
    this.options.link.subscribeCluster(clusterId)
    this.options.onChange()
  }

  close(clusterId: string) {
    if (!this.opened.delete(clusterId)) return
    this.options.link.unsubscribeCluster(clusterId)
    this.options.onChange()
  }

  /** What the relay client hands over from `onClusterUpdate`. */
  handle(update: ClusterUpdate): Promise<void> {
    this.queue = this.queue.then(() => this.apply(update)).catch(() => {})
    return this.queue
  }

  // MARK: Clusters and members

  async create(info: ClusterInfo, profile?: ClusterMemberProfile): Promise<string | null> {
    return this.act(async () => {
      const { cluster } = await this.options.api.create(this.options.accountKey, this.options.account, info, profile)
      await this.refresh()
      return cluster.id
    })
  }

  /** Joins with a pasted or scanned invite, or a link to the website that holds one. */
  async join(text: string, profile?: ClusterMemberProfile): Promise<string | null> {
    const invite = parseClusterInvite(text)
    if (!invite) return this.fail('This is not a cluster invite: it starts with tontoncluster1.')
    if (new URL(invite.relay).origin !== new URL(this.options.relay).origin)
      return this.fail(`This invite is for another relay: ${new URL(invite.relay).host}.`)
    return this.act(async () => {
      const cluster = await this.options.api.join(this.options.accountKey, this.options.account, invite, profile)
      await this.refresh()
      return cluster.id
    })
  }

  leave(clusterId: string) {
    return this.act(async () => {
      await this.options.api.leave(clusterId)
      this.close(clusterId)
      await this.refresh()
      return true
    })
  }

  /** The owner deletes the cluster for everyone. */
  remove(clusterId: string) {
    return this.act(async () => {
      await this.options.api.remove(clusterId)
      this.close(clusterId)
      await this.refresh()
      return true
    })
  }

  /** The owner: a new invite, as the link to share, with the cluster key it holds now. */
  invite(clusterId: string, options: { uses: number; hours: number }) {
    return this.act(async () => {
      const keyring = this.opened.get(clusterId)?.keyring
      const key = keyring?.key(keyring.version)
      if (!keyring || !key) throw new Error('The cluster is still opening: try again in a moment.')
      const created = await this.options.api.createInvite(clusterId, options)
      return {
        ...created,
        link: clusterInviteLink({ relay: this.options.relay, cluster: clusterId, token: created.token, key, version: keyring.version }),
      }
    })
  }

  invites(clusterId: string): Promise<ClusterInviteSummary[] | null> {
    return this.act(() => this.options.api.invites(clusterId))
  }

  revokeInvite(clusterId: string, inviteId: string) {
    return this.act(async () => {
      await this.options.api.revokeInvite(clusterId, inviteId)
      return true
    })
  }

  /** The owner kicks a member and rotates the key; the new snapshot is read with it. Returns who needs a new invite. */
  kick(clusterId: string, member: string) {
    return this.act(async () => {
      const { skipped } = await this.options.api.kick(this.options.accountKey, this.options.account, clusterId, member)
      await this.refresh()
      this.options.link.subscribeCluster(clusterId)
      return skipped
    })
  }

  /** The owner: a new name, sealed with the latest key. */
  async updateInfo(clusterId: string, info: ClusterInfo): Promise<boolean> {
    const vault = this.opened.get(clusterId)?.vault
    if (!vault) return false
    return this.send(clusterId, { t: 'cluster_info', clusterId, info: await vault.seal(info) })
  }

  /** This member's own name in the cluster. */
  async updateProfile(clusterId: string, profile: ClusterMemberProfile): Promise<boolean> {
    const vault = this.opened.get(clusterId)?.vault
    if (!vault) return false
    return this.send(clusterId, { t: 'cluster_profile', clusterId, profile: await vault.seal(profile) })
  }

  // MARK: This account's sessions

  /**
   * Puts one of this account's sessions in, or changes how it takes posts. Its agent gets the order sealed with the
   * account key, with the cluster key it holds now; the cluster sees the profile. False while the cluster is still
   * opening or the socket is down. The relay refuses a session that is not this account's.
   */
  async putSession(clusterId: string, sessionId: string, profile: ClusterSessionProfile, choice: ClusterSessionChoice): Promise<boolean> {
    const opened = this.opened.get(clusterId)
    const keyring = opened?.keyring
    const key = keyring?.key(keyring.version)
    if (!opened?.vault || !keyring || !key) return false
    const order = await sealClusterSessionOrder(this.options.accountKey, {
      clusterId,
      sessionId,
      key,
      version: keyring.version,
      delivery: choice.delivery,
      ...(choice.liveWithoutPrompts ? { liveWithoutPrompts: true } : {}),
    })
    return this.send(clusterId, { t: 'cluster_join_session', clusterId, sessionId, order, profile: await opened.vault.seal(profile) })
  }

  takeSessionOut(clusterId: string, sessionId: string): boolean {
    return this.send(clusterId, { t: 'cluster_leave_session', clusterId, sessionId })
  }

  // MARK: Documents

  /** The owner sets the clock: a deadline and milestones, sealed, over the revision this member saw. */
  async setClock(clusterId: string, clock: ClusterClock): Promise<boolean> {
    const opened = this.opened.get(clusterId)
    if (!opened?.vault || !opened.state) return false
    const rev = opened.state.docs.find(doc => doc.name === 'clock')?.rev ?? 0
    return this.send(clusterId, { t: 'cluster_doc', clusterId, name: 'clock', rev, blob: await opened.vault.seal(clock) })
  }

  /** Whether this member's Tonton is on the cluster's leaderboard. */
  sharesHero(clusterId: string): boolean {
    return this.opened.get(clusterId)?.leaderboard?.heroes.some(hero => hero.account === this.options.account) ?? false
  }

  /**
   * Puts this member's Tonton on the leaderboard, or keeps its entry up to date: its level, what it wears, its XP today
   * and since the clock started or it joined. Null takes it off. Only its own entry changes; an entry that says the same
   * is not written again. A write that crosses another member's is made again over the newer document.
   */
  async shareHero(clusterId: string, hero: RPGState | null, now: number = Date.now()): Promise<boolean> {
    const opened = this.opened.get(clusterId)
    if (!opened?.vault || !opened.state) return false
    const account = this.options.account
    const me = opened.state.members.find(member => member.account === account)
    if (!me) return false
    opened.sharing = { hero }
    // A board that exists but does not open (a key this client lacks yet) is never written over: the others would go.
    const doc = opened.state.docs.find(item => item.name === CLUSTER_LEADERBOARD)
    if (doc && !opened.leaderboard) {
      opened.problem = 'The leaderboard does not open with the keys you hold yet: nothing was changed.'
      this.options.onChange()
      return false
    }
    const previous = opened.leaderboard?.heroes.find(entry => entry.account === account) ?? null
    const entry = hero ? clusterHeroEntry(hero, account, clusterHeroFrom(opened.clock?.startedAt, me.joinedAt), previous, now) : null
    if (sameClusterHero(previous, entry)) return true
    const board = withClusterHero(opened.leaderboard, account, entry)
    const blob = await opened.vault.seal(sealedClusterLeaderboard(board))
    return this.send(clusterId, { t: 'cluster_doc', clusterId, name: CLUSTER_LEADERBOARD, rev: doc?.rev ?? 0, blob })
  }

  clearProblem(clusterId?: string) {
    if (clusterId) {
      const opened = this.opened.get(clusterId)
      if (opened) opened.problem = null
    } else this.listProblem = null
    this.options.onChange()
  }

  // MARK: Updates

  private async apply(update: ClusterUpdate) {
    const clusterId = update.t === 'cluster_snapshot' ? update.cluster.id : update.clusterId
    const opened = this.opened.get(clusterId)
    if (!opened) return
    if (update.t === 'cluster_snapshot') {
      await this.unlock(opened, update.cluster.members, update.cluster.own)
      opened.state = opened.vault ? await opened.vault.snapshot(update.cluster) : null
      const members = opened.state?.members.length
      if (members !== undefined)
        this.listed = this.listed.map(listed =>
          listed.summary.id === clusterId ? { ...listed, summary: { ...listed.summary, members } } : listed,
        )
      await this.republish(clusterId, opened)
      await this.openDocs(opened)
    } else if (update.t === 'cluster_key') {
      // A new version of the key: the next snapshot is read with it.
      this.options.link.subscribeCluster(clusterId)
      return
    } else if (update.t === 'cluster_removed') {
      this.opened.delete(clusterId)
      await this.refresh()
      return
    } else if (update.t === 'cluster_error') {
      opened.problem = update.message
    } else if (update.t === 'cluster_conflict') {
      if (update.current && opened.state && opened.vault) {
        opened.state = await opened.vault.apply(opened.state, { t: 'cluster_doc', clusterId, doc: update.current })
        await this.openDocs(opened)
      }
      // Another member's client wrote its own entry first: this one is put in, or taken out of, the newer board.
      if (update.name === CLUSTER_LEADERBOARD) {
        if (opened.sharing) await this.shareHero(clusterId, opened.sharing.hero)
      } else opened.problem = `Someone changed the ${update.name} meanwhile: check it and try again.`
    } else if (opened.state && opened.vault) {
      const next = await opened.vault.apply(opened.state, update)
      if (!next) {
        this.opened.delete(clusterId)
        await this.refresh()
        return
      }
      opened.state = next
      const startedAt = opened.clock?.startedAt
      if (update.t === 'cluster_doc') await this.openDocs(opened)
      // A clock that starts (again) is where this member's count starts: its entry follows at once.
      if (opened.sharing?.hero && opened.clock?.startedAt !== startedAt) await this.shareHero(clusterId, opened.sharing.hero)
      // The list says the name and how many members: both can change while the cluster is open.
      this.listed = this.listed.map(listed =>
        listed.summary.id === clusterId
          ? { summary: { ...listed.summary, members: next.members.length }, info: next.info ?? listed.info }
          : listed,
      )
    }
    this.options.onChange()
  }

  /** The keys of the cluster: the member's own copy, then every later version wrapped for it that opens. */
  private async unlock(opened: Opened, members: readonly ClusterMemberWire[], own: ClusterState['own'] | undefined) {
    const summary = { ...opened.summary, secret: own?.secret ?? opened.summary.secret, wraps: own?.wraps ?? opened.summary.wraps }
    const resolved = await resolveClusterKeyring(this.options.accountKey, this.options.account, summary, members)
    if (!resolved) {
      opened.problem = 'The cluster key does not open with this account key.'
      return
    }
    opened.keyring = resolved.keyring
    opened.secret = resolved.secret
    opened.vault = new ClusterVault(resolved.keyring)
  }

  private async openDocs(opened: Opened) {
    const { vault, state } = opened
    if (!vault || !state) return
    const [notes, claims, clock, leaderboard] = await Promise.all([
      vault.doc(state, 'notes', decodeClusterNotes),
      vault.doc(state, 'claims', decodeClusterClaims),
      vault.doc(state, 'clock', decodeClusterClock),
      vault.doc(state, CLUSTER_LEADERBOARD, decodeClusterLeaderboard),
    ])
    Object.assign(opened, { notes, claims, clock, leaderboard })
  }

  /** After a rotation, publishes this member's public key under the new version, so the owner can wrap the next one. */
  private async republish(clusterId: string, opened: Opened) {
    const me = opened.state?.members.find(member => member.account === this.options.account)
    if (!opened.keyring || !opened.secret || !me || !needsRepublish(opened.keyring, me.publicKeys)) return
    const scope = clusterKeyScope(clusterId)
    this.options.link.sendCluster({
      t: 'cluster_member_key',
      clusterId,
      publicKey: await sealPoolMemberKey(opened.keyring, scope, this.options.account, opened.secret),
      secret: await sealPoolMemberSecret(this.options.accountKey, opened.secret),
    })
  }

  private async infoOf(summary: ClusterSummary): Promise<ClusterInfo | null> {
    const opened = this.opened.get(summary.id)
    if (opened?.state) return opened.state.info
    if (!(await openClusterGrant(this.options.accountKey, summary.key, summary.id))) return null
    // The name may be sealed with a later key: the members' public keys open the wraps.
    const members = summary.wraps.length ? await this.options.api.members(summary.id).catch(() => []) : []
    const resolved = await resolveClusterKeyring(this.options.accountKey, this.options.account, summary, members)
    return resolved ? new ClusterVault(resolved.keyring).read(summary.info, decodeClusterInfo) : null
  }

  private send(clusterId: string, message: ClusterAppMessage): boolean {
    if (this.options.link.sendCluster(message)) return true
    const opened = this.opened.get(clusterId)
    if (opened) opened.problem = 'Not connected to the relay: nothing was changed.'
    this.options.onChange()
    return false
  }

  private fail(message: string): null {
    this.listProblem = message
    this.options.onChange()
    return null
  }

  /** Runs an action, keeping what the relay said when it refuses. */
  private async act<T>(run: () => Promise<T>): Promise<T | null> {
    try {
      return await run()
    } catch (error) {
      return this.fail(this.messageOf(error))
    }
  }

  private messageOf(error: unknown): string {
    if (error instanceof Error) {
      if ('status' in error && error.status === 404 && /not found|HTTP 404/i.test(error.message)) {
        this.relayKnowsClusters = false
        return CLUSTERS_UNSUPPORTED
      }
      return error.message
    }
    return String(error)
  }
}
