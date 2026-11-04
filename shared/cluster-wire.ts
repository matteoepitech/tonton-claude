// Reads the cluster messages the relay sends, like shared/pool-wire.ts for pools: the relay is not trusted, so a message
// whose shape is wrong is dropped, a record whose shape is wrong is left out, and unknown fields are ignored.

import { CLUSTER_DOC_NAME, isClusterRole } from './cluster'
import type {
  ClusterDocWire,
  ClusterMemberWire,
  ClusterPostWire,
  ClusterSessionWire,
  ClusterSnapshot,
  ClusterToAgent,
  ClusterUpdate,
} from './cluster-protocol'
import type { PoolKeyWrapWire } from './pool-keys'

type Fields = Record<string, unknown>

const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === 'string'
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0
const isNullableText = (value: unknown): value is string | null => value === null || isText(value)
const isOptionalText = (value: unknown): value is string | undefined => value === undefined || isText(value)
/** The machine is the relay's attestation of who wrote it: a wrong shape drops the record rather than mislabel it. */
const isAuthor = (value: Fields) => isText(value.account) && isNullableText(value.session) && isOptionalText(value.machine)
const list = <T>(value: unknown, check: (item: unknown) => item is T): T[] | null => (Array.isArray(value) ? value.filter(check) : null)

const isMember = (value: unknown): value is ClusterMemberWire =>
  isFields(value) &&
  isText(value.account) &&
  isClusterRole(value.role) &&
  isText(value.joinedAt) &&
  isNullableText(value.profile) &&
  Array.isArray(value.publicKeys) &&
  value.publicKeys.every(isText)

const isSession = (value: unknown): value is ClusterSessionWire =>
  isFields(value) &&
  isText(value.account) &&
  isText(value.session) &&
  isOptionalText(value.machine) &&
  isText(value.joinedAt) &&
  isNullableText(value.profile) &&
  typeof value.online === 'boolean' &&
  typeof value.ready === 'boolean' &&
  isOptionalText(value.status)

const isPost = (value: unknown): value is ClusterPostWire =>
  isFields(value) && isText(value.id) && isCount(value.seq) && isText(value.ts) && isText(value.blob) && isAuthor(value)

const isDoc = (value: unknown): value is ClusterDocWire =>
  isFields(value) &&
  isText(value.name) &&
  CLUSTER_DOC_NAME.test(value.name) &&
  isCount(value.rev) &&
  isText(value.updatedAt) &&
  isText(value.blob) &&
  isAuthor(value)

const isWrap = (value: unknown): value is PoolKeyWrapWire =>
  isFields(value) && isCount(value.version) && value.version >= 2 && isText(value.from) && isText(value.blob)

/** The member's own keys in a snapshot: left out when their shape is wrong. */
function own(value: unknown): ClusterSnapshot['own'] {
  if (!isFields(value) || !isNullableText(value.secret)) return undefined
  return { secret: value.secret, wraps: list(value.wraps, isWrap) ?? [] }
}

function snapshot(value: unknown): ClusterSnapshot | null {
  if (!isFields(value) || !isText(value.id) || !isText(value.createdAt) || !isCount(value.keyVersion) || !isText(value.info)) return null
  const members = list(value.members, isMember)
  const sessions = list(value.sessions, isSession)
  const posts = list(value.posts, isPost)
  const docs = list(value.docs, isDoc)
  if (!members || !sessions || !posts || !docs) return null
  const mine = own(value.own)
  const { id, createdAt, keyVersion, info } = value
  return { id, createdAt, keyVersion, info, members, sessions, posts, docs, ...(mine ? { own: mine } : {}) }
}

/** A cluster message from the relay, or null for one this client does not know or with the wrong shape. */
export function parseClusterUpdate(value: unknown): ClusterUpdate | null {
  if (!isFields(value) || !isText(value.t)) return null
  if (value.t === 'cluster_snapshot') {
    const cluster = snapshot(value.cluster)
    return cluster ? { t: 'cluster_snapshot', cluster } : null
  }
  const clusterId = value.clusterId
  if (!isText(clusterId)) return null
  switch (value.t) {
    case 'cluster_post':
      return isPost(value.post) ? { t: 'cluster_post', clusterId, post: value.post } : null
    case 'cluster_doc':
      return isDoc(value.doc) ? { t: 'cluster_doc', clusterId, doc: value.doc } : null
    case 'cluster_info':
      return isText(value.info) && isCount(value.keyVersion)
        ? { t: 'cluster_info', clusterId, info: value.info, keyVersion: value.keyVersion }
        : null
    case 'cluster_member':
      return isMember(value.member) ? { t: 'cluster_member', clusterId, member: value.member } : null
    case 'cluster_member_left':
      return isText(value.account) ? { t: 'cluster_member_left', clusterId, account: value.account } : null
    case 'cluster_session':
      return isSession(value.session) ? { t: 'cluster_session', clusterId, session: value.session } : null
    case 'cluster_session_left':
      return isText(value.account) && isText(value.session)
        ? { t: 'cluster_session_left', clusterId, account: value.account, session: value.session }
        : null
    case 'cluster_key':
      return isWrap(value.wrap) ? { t: 'cluster_key', clusterId, wrap: value.wrap } : null
    case 'cluster_conflict': {
      if (!isText(value.name)) return null
      const current = value.current === null ? null : isDoc(value.current) ? value.current : undefined
      return current === undefined ? null : { t: 'cluster_conflict', clusterId, name: value.name, current }
    }
    case 'cluster_removed':
      return { t: 'cluster_removed', clusterId }
    case 'cluster_error':
      return isText(value.message) ? { t: 'cluster_error', clusterId, message: value.message } : null
    default:
      return null
  }
}

/** A join or a leave for an agent, or null. */
export function parseClusterToAgent(value: unknown): ClusterToAgent | null {
  if (!isFields(value) || !isText(value.sessionId) || !isText(value.clusterId)) return null
  const { sessionId, clusterId } = value
  if (value.t === 'cluster_join') return isText(value.order) ? { t: 'cluster_join', sessionId, clusterId, order: value.order } : null
  if (value.t === 'cluster_left') return { t: 'cluster_left', sessionId, clusterId }
  return null
}

/** The relay's messages for an agent that are orders to it rather than changes of a cluster. */
export const isClusterOrderType = (t: unknown): boolean => t === 'cluster_join' || t === 'cluster_left'

export const isClusterMessageType = (t: unknown): boolean => typeof t === 'string' && t.startsWith('cluster_')
