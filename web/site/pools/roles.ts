// What the pages call the roles of a pool.
import type { PoolRole } from '../../../shared'

const ROLE_LABELS: Record<PoolRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' }

export const roleLabel = (role: PoolRole): string => ROLE_LABELS[role]
export const ROLES = Object.keys(ROLE_LABELS) as PoolRole[]
