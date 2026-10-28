import { VERSION_PATTERN } from '../../shared/version'
import { MAX_BLOB_BYTES, MAX_RPG_BYTES } from './limits'

/** The relay validates only the opaque document and its compare-and-swap revision. */
export function isRPGWrite(value: unknown): value is { rev: number; blob: string } {
  if (!value || typeof value !== 'object') return false
  const { rev, blob } = value as Record<string, unknown>
  return typeof rev === 'number' && Number.isSafeInteger(rev) && rev >= 0 && rev < Number.MAX_SAFE_INTEGER && isSealed(blob, MAX_RPG_BYTES)
}

export const isText = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maxLength

export const isSealed = (value: unknown, maxLength = MAX_BLOB_BYTES): value is string => isText(value, maxLength)

export const isSessionId = (value: unknown): value is string => isText(value, 128)

export const isRequestId = (value: unknown): value is string => isText(value, 32)

/** The random ids the app gives a start, a log request or a diagnosis. */
const ORDER_ID = /^[a-z0-9]{8,32}$/

export const isLaunchId = (value: unknown): value is string => typeof value === 'string' && ORDER_ID.test(value)

export const isRequestToken = (value: unknown): value is string => typeof value === 'string' && ORDER_ID.test(value)

export const isStartState = (value: unknown): value is 'starting' | 'asking' | 'started' | 'failed' =>
  value === 'starting' || value === 'asking' || value === 'started' || value === 'failed'

export const isVersion = (value: unknown): value is string => typeof value === 'string' && VERSION_PATTERN.test(value)

/** The random id an install of the iPhone app registers its tokens under. */
export const isDeviceId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(value)

/** An APNs device or Live Activity token, hex. */
export const isPushToken = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-fA-F]{64,512}$/.test(value)

/** A pool's id, chosen by the client that creates it: 12 base64url characters, like the relay's own ids. */
export const isPoolId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{12}$/.test(value)

/** The id a client gives a pool task, message or event. */
export const isPoolItemId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(value)

export const isPoolRole = (value: unknown): value is 'owner' | 'admin' | 'member' | 'viewer' =>
  value === 'owner' || value === 'admin' || value === 'member' || value === 'viewer'

export const isRevision = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

/** An account id, as the relay issues them. */
export const isAccountId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{12}$/.test(value)

/** A machine id, as the relay issues them. */
export const isMachineId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{12}$/.test(value)

/** A pool machine named by its owner's account and its id. */
export const isMachineRef = (value: unknown): value is { account: string; machine: string } =>
  typeof value === 'object' &&
  value !== null &&
  isAccountId((value as { account?: unknown }).account) &&
  isMachineId((value as { machine?: unknown }).machine)
