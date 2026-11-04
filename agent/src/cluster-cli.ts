// `tonton cluster`: the machine's owner puts its sessions in a cluster, or takes them out, from the machine itself
// (docs/cluster.md, Putting a session in). It only writes the rules each session's channel reads
// (agent/src/channel/cluster-joins.ts): sessions join on their own socket, with an order sealed with the account key.

import { resolve } from 'node:path'
import { ClusterVault, decodeClusterInfo } from '../../shared/cluster'
import { ClusterApi } from '../../shared/cluster-api'
import type { ClusterDelivery } from '../../shared/cluster-protocol'
import { type ClusterJoinRule, type ClusterLeaveRule, latestClusterKey, readClusterJoins, writeClusterJoins } from './channel/cluster-joins'
import { type AgentConfig, loadConfig } from './config'

export const CLUSTER_USAGE = `  tonton cluster list                     the clusters of this account, and what joins them from this machine
  tonton cluster join <cluster> [folder]  the sessions of the folder (this one by default) join, now and when they start
       [--session <id>]                   one session instead of a folder
       [--live | --digest | --muted]      how they take posts (live by default)
       [--live-without-prompts]           live even for a session that skips permission prompts
  tonton cluster leave [cluster] [folder] they leave it, or every cluster [--session <id>]`

interface Options {
  positional: string[]
  session?: string
  delivery?: ClusterDelivery
  liveWithoutPrompts: boolean
}

export function parseClusterArgs(args: string[]): Options | string {
  const options: Options = { positional: [], liveWithoutPrompts: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--session') {
      const session = args[++i]
      if (!session) return '--session needs a session id.'
      options.session = session
    } else if (arg === '--live' || arg === '--digest' || arg === '--muted') {
      if (options.delivery) return 'Choose one of --live, --digest and --muted.'
      options.delivery = arg.slice(2) as ClusterDelivery
    } else if (arg === '--live-without-prompts') options.liveWithoutPrompts = true
    else if (arg.startsWith('--')) return `Unknown option ${arg}.`
    else options.positional.push(arg)
  }
  return options
}

/** Runs `tonton cluster …`: what to print, and whether it went wrong. */
export async function runClusterCommand(
  args: string[],
  config = loadConfig(),
  cwd = process.cwd(),
): Promise<{ text: string; ok: boolean }> {
  if (!config) return { text: 'Not set up. Copy the token from Tonton Claude › Machines on your Mac.', ok: false }
  const [command, ...rest] = args
  const options = parseClusterArgs(rest)
  if (typeof options === 'string') return { text: options, ok: false }
  try {
    if (command === 'list') return { text: await list(config), ok: true }
    if (command === 'join') return await join(config, options, cwd)
    if (command === 'leave') return await leave(config, options, cwd)
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), ok: false }
  }
  return { text: `Usage:\n${CLUSTER_USAGE}`, ok: false }
}

/** The account's clusters, with their names opened with the latest key this account holds. */
async function clusters(config: AgentConfig) {
  const api = new ClusterApi({ relay: config.server, token: config.token, agent: true })
  const summaries = await api.list().catch(error => {
    throw new Error(
      `The relay did not list the clusters (${error instanceof Error ? error.message : String(error)}). It may be older than clusters.`,
    )
  })
  return Promise.all(
    summaries.map(async summary => {
      const keyring = await latestClusterKey(config, summary, api)
      const info = keyring ? await new ClusterVault(keyring).read(summary.info, decodeClusterInfo) : null
      return { summary, keyring, name: info?.name ?? summary.id }
    }),
  )
}

async function list(config: AgentConfig): Promise<string> {
  const [found, rules] = await Promise.all([clusters(config), readClusterJoins(config.key)])
  if (!found.length) return 'This account is in no cluster. Join one from the app or the website, with an invite.'
  const lines = found.map(({ summary, name }) => {
    const joins = rules.joins.filter(rule => rule.clusterId === summary.id).map(target)
    return `${name} (${summary.id}, ${summary.role})${joins.length ? `\n  joined by ${joins.join(', ')}` : ''}`
  })
  return lines.join('\n')
}

async function join(config: AgentConfig, options: Options, cwd: string) {
  const [wanted, folderArg] = options.positional
  if (!wanted) return { text: `Say which cluster.\n${CLUSTER_USAGE}`, ok: false }
  const found = await clusters(config)
  const matching = found.filter(({ summary, name }) => summary.id === wanted || name.toLowerCase() === wanted.toLowerCase())
  if (matching.length > 1) return { text: `Several clusters are named ${wanted}: say which by id (tonton cluster list).`, ok: false }
  const cluster = matching[0]
  if (!cluster) return { text: `This account is not in a cluster ${wanted} (tonton cluster list).`, ok: false }
  if (!cluster.keyring) return { text: 'The cluster key does not open with this machine’s account key.', ok: false }
  const folder = options.session ? undefined : resolve(cwd, folderArg ?? '.')
  const rule: ClusterJoinRule = {
    clusterId: cluster.summary.id,
    name: cluster.name,
    key: cluster.keyring.key(cluster.keyring.version) as string,
    version: cluster.keyring.version,
    ...(folder ? { folder } : { session: options.session }),
    ...(options.delivery ? { delivery: options.delivery } : {}),
    ...(options.liveWithoutPrompts ? { liveWithoutPrompts: true } : {}),
    issuedAt: new Date().toISOString(),
  }
  const rules = await readClusterJoins(config.key)
  const others = rules.joins.filter(old => old.clusterId !== rule.clusterId || old.folder !== rule.folder || old.session !== rule.session)
  await writeClusterJoins(config.key, { ...rules, joins: [...others, rule] })
  const how = options.delivery ?? 'live'
  const who = folder
    ? `The sessions of ${folder} join ${cluster.name}: those running now, and every new one started there`
    : `Session ${options.session} joins ${cluster.name}`
  return { text: `${who} (${how}).`, ok: true }
}

async function leave(config: AgentConfig, options: Options, cwd: string) {
  const rules = await readClusterJoins(config.key)
  // A cluster named first, when it is one: either a join rule's, or one of the account's.
  const wanted: string | undefined = options.positional[0]
  let folderArg: string | undefined = options.positional[1]
  let clusterId: string | undefined
  if (wanted) {
    const ruled = rules.joins.find(rule => rule.clusterId === wanted || rule.name?.toLowerCase() === wanted.toLowerCase())
    clusterId = ruled?.clusterId
    if (!clusterId) {
      const found = await clusters(config).catch(() => [])
      clusterId = found.find(({ summary, name }) => summary.id === wanted || name.toLowerCase() === wanted.toLowerCase())?.summary.id
    }
    // Not a cluster: the folder.
    if (!clusterId && folderArg === undefined) folderArg = wanted
    else if (!clusterId) return { text: `This account is not in a cluster ${wanted} (tonton cluster list).`, ok: false }
  }
  const folder = options.session ? undefined : resolve(cwd, folderArg ?? '.')
  const leaveRule: ClusterLeaveRule = {
    ...(clusterId ? { clusterId } : {}),
    ...(folder ? { folder } : { session: options.session }),
    issuedAt: new Date().toISOString(),
  }
  const joins = rules.joins.filter(
    rule => !((!clusterId || rule.clusterId === clusterId) && rule.folder === leaveRule.folder && rule.session === leaveRule.session),
  )
  await writeClusterJoins(config.key, { joins, leaves: [...rules.leaves, leaveRule] })
  const what = clusterId ? (rules.joins.find(rule => rule.clusterId === clusterId)?.name ?? clusterId) : 'every cluster'
  const who = folder ? `The sessions of ${folder}` : `Session ${options.session}`
  return { text: `${who} leave ${what}.`, ok: true }
}

const target = (rule: ClusterJoinRule) =>
  `${rule.folder ?? `session ${rule.session}`}${rule.delivery && rule.delivery !== 'live' ? ` (${rule.delivery})` : ''}`
