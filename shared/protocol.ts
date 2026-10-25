// Messages exchanged between the agent (one per Claude Code session), the relay and the Mac app.
//
// Everything that describes what Claude is doing (conversation, names, paths, prompts, tool calls) travels as a
// `Sealed` string: AES-256-GCM encrypted with the account key, which only the Mac app and the enrolled machines hold.
// The relay routes and stores these blobs without being able to read them.

export type Sealed = string // base64(nonce[12] | ciphertext | tag[16])

export type SessionStatus = 'starting' | 'working' | 'waiting' | 'permission' | 'idle' | 'error' | 'ended' | 'offline'

export interface ImageData {
  mediaType: string
  data: string // base64
}

// A conversation entry, normalized from the Claude Code transcript (plaintext, before sealing).
export type Entry =
  | { id: string; ts: string; kind: 'user'; text: string; images?: ImageData[]; viaNotch?: boolean }
  | { id: string; ts: string; kind: 'assistant'; text: string }
  | { id: string; ts: string; kind: 'tool'; toolUseId: string; name: string; summary: string }
  | { id: string; ts: string; kind: 'tool_result'; toolUseId: string; text: string; isError: boolean; images?: ImageData[] }
  | { id: string; ts: string; kind: 'system'; text: string }

// Plaintext payloads, sealed before leaving the machine.
export interface SessionInfo {
  machine: string
  platform?: string
  cwd: string
  project: string
}
export interface SessionMeta {
  title?: string
  costUSD?: number
  lastMessage?: string
}
export interface StatusDetail {
  text: string
}
export interface PermissionDetail {
  toolName: string
  description: string
  inputPreview: string
}
export interface PromptPayload {
  text: string
  images: { name: string; mediaType: string; data: string }[]
}
/** Sealed by the app, so only the account owner can make a machine update itself, not the relay. */
export interface UpdateOrder {
  version: string
  issuedAt: string
}

export interface SealedEntry {
  id: string
  ts: string
  blob: Sealed
}
export interface SealedPermission {
  requestId: string
  ts: string
  blob: Sealed
}

export interface SessionSummary {
  id: string
  machineId: string
  status: SessionStatus
  agentOnline: boolean
  canChat: boolean
  info: Sealed | null
  meta: Sealed | null
  statusDetail: Sealed | null
  pendingPermissions: SealedPermission[]
  startedAt: string
  lastActivity: string
}

export interface MachineSummary {
  id: string
  name: Sealed
  createdAt: string
  lastSeen: string | null
  online: boolean
  /** Agent version installed on the machine, null until an agent that reports it connects. */
  agentVersion: string | null
}

// agent -> relay
export type AgentMessage =
  | { t: 'hello'; sessionId: string; info: Sealed; channel: boolean }
  | { t: 'entries'; sessionId: string; entries: SealedEntry[]; reset: boolean }
  | { t: 'meta'; sessionId: string; meta: Sealed }
  | { t: 'permission'; sessionId: string; request: SealedPermission }
  | { t: 'permission_closed'; sessionId: string; requestId: string }
  // Sent by the channel that ran an update. `detail` is a sealed `{ text }` explaining a failure.
  | { t: 'update_result'; ok: boolean; version: string | null; detail: Sealed | null }

// relay -> agent
export type RelayToAgent =
  | { t: 'prompt'; sessionId: string; payload: Sealed }
  | { t: 'verdict'; sessionId: string; requestId: string; behavior: 'allow' | 'deny' }
  | { t: 'update'; order: Sealed }

// hook -> relay (HTTP POST /api/hook)
export interface HookPost {
  event: { hook_event_name: string; session_id: string; notification_type?: string; source?: string }
  detail?: Sealed
}

// relay -> app
export type RelayToApp =
  | { t: 'snapshot'; sessions: SessionSummary[]; machines: MachineSummary[]; latestAgentVersion: string }
  | { t: 'session'; session: SessionSummary }
  | { t: 'removed'; sessionId: string }
  | { t: 'machines'; machines: MachineSummary[]; latestAgentVersion: string }
  | { t: 'history'; sessionId: string; entries: SealedEntry[] }
  | { t: 'entries'; sessionId: string; entries: SealedEntry[]; reset: boolean }
  | { t: 'error'; message: string }
  // `reason` when the relay could not ask the machine, `detail` when the agent tried and failed.
  | { t: 'agent_update'; machineId: string; ok: boolean; reason?: 'offline' | 'unsupported'; detail?: Sealed | null }

// app -> relay
export type AppMessage =
  | { t: 'subscribe'; sessionId: string | null }
  | { t: 'prompt'; sessionId: string; payload: Sealed }
  | { t: 'verdict'; sessionId: string; requestId: string; behavior: 'allow' | 'deny' }
  | { t: 'dismiss'; sessionId: string }
  | { t: 'update_agent'; machineId: string; order: Sealed }
