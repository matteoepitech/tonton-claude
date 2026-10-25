import { VERSION_PATTERN } from '../../shared/version'
import { MAX_BLOB_BYTES } from './limits'

export const isText = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maxLength

export const isSealed = (value: unknown, maxLength = MAX_BLOB_BYTES): value is string => isText(value, maxLength)

export const isSessionId = (value: unknown): value is string => isText(value, 128)

export const isRequestId = (value: unknown): value is string => isText(value, 32)

export const isVersion = (value: unknown): value is string => typeof value === 'string' && VERSION_PATTERN.test(value)
