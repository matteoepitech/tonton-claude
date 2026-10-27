import { VERSION_PATTERN } from '../../shared/version'
import { MAX_BLOB_BYTES } from './limits'

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
