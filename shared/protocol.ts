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

/** A text replacement of an Edit or MultiEdit call, cut when it is long. */
export interface FileEdit {
  oldText: string
  newText: string
}

// A conversation entry, normalized from the Claude Code transcript (plaintext, before sealing).
export type Entry =
  | { id: string; ts: string; kind: 'user'; text: string; images?: ImageData[]; viaNotch?: boolean }
  | { id: string; ts: string; kind: 'assistant'; text: string }
  | { id: string; ts: string; kind: 'tool'; toolUseId: string; name: string; summary: string; edits?: FileEdit[] }
  | { id: string; ts: string; kind: 'tool_result'; toolUseId: string; text: string; isError: boolean; images?: ImageData[] }
  | { id: string; ts: string; kind: 'system'; text: string }

// Plaintext payloads, sealed before leaving the machine.
export interface SessionInfo {
  machine: string
  platform?: string
  cwd: string
  project: string
  /** The coding agent running the session. Missing for Claude Code, and from older agents. */
  tool?: 'opencode'
}
/** How much of a Claude plan's usage window is spent, as Claude Code reports it. */
export interface UsageLimit {
  /** 0 to 100. */
  usedPercent: number
  resetsAt: string
}
/** Tokens of a session's API responses, summed from its transcript. */
export interface TokenCounts {
  input: number
  output: number
  /** Input read from or written to the prompt cache, billed apart from the rest. */
  cacheRead: number
  cacheWrite: number
}
/** How full a session's context is: the input of its last API response, against the model's context window. */
export interface ContextUsage {
  usedTokens: number
  /** Unknown with Claude Code versions that report neither the status line's window nor the model they asked for. */
  windowTokens?: number
}
export interface SessionMeta {
  title?: string
  costUSD?: number
  tokens?: TokenCounts
  context?: ContextUsage
  lastMessage?: string
  /** The 5-hour window of the account the session runs on. Absent with an API key, and until Claude Code reports it. */
  fiveHourLimit?: UsageLimit
  /** The weekly window, like the 5-hour one. */
  sevenDayLimit?: UsageLimit
  /** The session runs in tmux, so the notch can type slash commands in it. Missing from older agents. */
  terminal?: boolean
  /**
   * The commands the agent can run in this session: Claude Code in tmux types them, OpenCode runs them through its API.
   * Agents that send `terminal` without it only know `compact` and `clear`.
   */
  commands?: SessionCommand['name'][]
  /** The model that last answered or that the session switched to, as Claude Code names it (`claude-opus-4-5-20251101`).
   * Missing from older agents, and until Claude Code reports it. */
  model?: string
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
  /** A slash command to type in the session's terminal instead of a message. Sent only to sessions whose meta says `terminal`. */
  command?: SessionCommand
}
/** Bound to its session and run once, so the relay can neither move a `/clear` to another session nor replay it. */
export interface SessionCommand {
  name: 'compact' | 'clear' | 'model' | 'interrupt'
  sessionId: string
  /** Random, safe as a file name. */
  id: string
  issuedAt: string
  /** For `model`: the alias `/model` takes, each standing for the latest model of its family. */
  model?: ModelAlias
}
export type ModelAlias = 'opus' | 'sonnet' | 'haiku'
/** What the background service reports about its machine every minute. */
export interface MachineHealth {
  /** Share of all cores in use since the previous report, from 0 to 1. */
  cpu: number
  memoryUsed: number
  memoryTotal: number
  /** Null on machines without a battery. */
  battery: { percent: number; charging: boolean } | null
  /** Where a Wake-on-LAN packet can reach the machine: each network card and its subnet's broadcast address. Sealed, like
   * the rest: the relay never sees the MAC addresses. Missing from older agents. */
  wake?: { mac: string; broadcast: string }[]
  at: string
}
/** A tool call the agent approves without asking: the tool, and a pattern for its command, path or URL. */
export interface PermissionRule {
  tool: string
  /** `npm test` matches that command only, `npm run *` any command starting with `npm run `. Empty: any call of the tool. */
  pattern?: string
}
/** Sealed by the app with its date, so the relay can neither forge rules nor bring back older ones. */
export interface RuleSet {
  rules: PermissionRule[]
  issuedAt: string
}
/**
 * Sealed by the app: start claude in this folder of this machine. Every machine of the account has the key, so the order
 * names the one it is for. Recent, like update orders, and run once.
 */
export interface StartOrder {
  launchId: string
  machineId: string
  cwd: string
  issuedAt: string
}
/** Sealed by the app: the user's answer to one question of one start, which the relay cannot reuse for another. */
export interface StartAnswer {
  launchId: string
  machineId: string
  /** The `question` of the `StartDetail` the user answered. */
  question: string
  confirm: boolean
  issuedAt: string
}
export type StartState = 'starting' | 'asking' | 'started' | 'failed'
/**
 * Sealed by the agent with each `session_start`. The app goes by it, not by the plain fields the relay could change, and
 * drops one that names another start, machine or state.
 */
export interface StartDetail {
  launchId: string
  machineId: string
  state: StartState
  /** The question while `asking`, why while `failed`, each followed by the last lines of Claude Code's screen. */
  text?: string
  /** A new random id for each question asked, that the answer repeats. */
  question?: string
  /** Once `started`. */
  sessionId?: string
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
  /** Sealed `MachineHealth`, null until the machine's service reports it. Older relays leave it out. */
  health?: Sealed | null
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
  // Sent by the background service every minute: a sealed `MachineHealth`.
  | { t: 'health'; health: Sealed }
  // A start from the app: `sessionId` once claude runs.
  | { t: 'session_start'; launchId: string; state: StartState; detail: Sealed }

// relay -> agent
export type RelayToAgent =
  | { t: 'prompt'; sessionId: string; payload: Sealed }
  | { t: 'verdict'; sessionId: string; requestId: string; behavior: 'allow' | 'deny' }
  | { t: 'update'; order: Sealed }
  // The machine's auto-approve rules, sealed `RuleSet`: on each connection, and when the app changes them.
  | { t: 'rules'; rules: Sealed }
  | { t: 'start_session'; launchId: string; order: Sealed }
  | { t: 'start_answer'; launchId: string; answer: Sealed }

// hook -> relay (HTTP POST /api/hook)
export interface HookPost {
  event: { hook_event_name: string; session_id: string; notification_type?: string; source?: string }
  detail?: Sealed
}

// relay -> app
export type RelayToApp =
  | { t: 'snapshot'; sessions: SessionSummary[]; machines: MachineSummary[] }
  | { t: 'session'; session: SessionSummary }
  | { t: 'removed'; sessionId: string }
  | { t: 'machines'; machines: MachineSummary[] }
  | { t: 'history'; sessionId: string; entries: SealedEntry[] }
  | { t: 'entries'; sessionId: string; entries: SealedEntry[]; reset: boolean }
  | { t: 'error'; message: string }
  // `reason` when the relay could not ask the machine, `detail` when the agent tried and failed.
  | { t: 'agent_update'; machineId: string; ok: boolean; reason?: 'offline' | 'unsupported'; detail?: Sealed | null }
  // `reason` when the relay could not reach the machine.
  | {
      t: 'session_start'
      machineId: string
      launchId: string
      state: StartState
      reason?: 'offline'
      detail?: Sealed | null
    }

// app -> relay
export type AppMessage =
  | { t: 'subscribe'; sessionId: string | null }
  | { t: 'prompt'; sessionId: string; payload: Sealed }
  | { t: 'verdict'; sessionId: string; requestId: string; behavior: 'allow' | 'deny' }
  | { t: 'dismiss'; sessionId: string }
  | { t: 'update_agent'; machineId: string; order: Sealed }
  | { t: 'rules'; machineId: string; rules: Sealed }
  | { t: 'start_session'; machineId: string; launchId: string; order: Sealed }
  | { t: 'start_answer'; machineId: string; launchId: string; answer: Sealed }
