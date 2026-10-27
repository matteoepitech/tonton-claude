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
  /**
   * A call made by a subagent, and its result: `parent` is the Task (Agent) call that started the subagent. New kinds
   * rather than `tool` with a parent, so apps from before them drop these instead of showing them as the session's own.
   */
  | { id: string; ts: string; kind: 'sub_tool'; parent: string; toolUseId: string; name: string; summary: string }
  | { id: string; ts: string; kind: 'sub_result'; parent: string; toolUseId: string; text: string; isError: boolean }

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
  /** The git branch of its folder, or the short commit when detached. Missing outside git and from older agents. */
  branch?: string
  /**
   * The last turns that ended, oldest first, as Claude Code writes them in the transcript: the app counts the ones it
   * didn't see end, while the Mac was away. Missing from older agents, and until a turn ends.
   */
  turns?: TurnTime[]
}
/** A turn of Claude, from the prompt to the answer: when it ended and how long it took. */
export interface TurnTime {
  end: string
  seconds: number
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
  /** The coding agents installed, which the notch can start there. Missing from older agents, which only start claude. */
  tools?: ('claude' | 'opencode')[]
  at: string
}
/** A tool call the agent approves without asking: the tool, and a pattern for its command, path or URL. */
export interface PermissionRule {
  tool: string
  /** `npm test` matches that command only, `npm run *` any command starting with `npm run `. Empty: any call of the tool. */
  pattern?: string
}
/**
 * Sealed by the app with an allowed request: approve calls like it until the session ends. Bound to the session and the
 * request, so the relay cannot hand it to another session.
 */
export interface SessionRules {
  sessionId: string
  requestId: string
  rules: PermissionRule[]
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
  /** What to start. Missing: claude. The app only sends `opencode` to agents whose health lists it. */
  tool?: 'opencode'
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
/**
 * Sealed by the app with the account key: also give this session's conversation to a read-only share, sealed with the
 * share's own key. The teammate who gets the share key reads that session only, and the account key never leaves.
 */
export interface ShareOrder {
  shareId: string
  sessionId: string
  /** Base64url AES-256 key of the share. */
  key: string
  /** The agent stops sealing for the share then, whatever the relay says. */
  expiresAt: string
}
/** What a read-only share shows, sealed with the share key. The machine and the folder stay with the account. */
export interface SharedInfo {
  project: string
  title?: string
  /** `opencode`, missing for Claude Code. */
  tool?: 'opencode'
}
/** A read-only share of one session, as the account lists it: never its token nor its key. */
export interface ShareSummary {
  id: string
  sessionId: string
  createdAt: string
  expiresAt: string
  viewers: number
}
/**
 * Sealed by the app: the user's own name for a session, shown instead of its project on every Mac of the account. It names
 * its session, so the relay can't move it to another. An empty name brings the project back.
 */
export interface SessionName {
  sessionId: string
  name: string
  issuedAt: string
}
/** Sealed by the app, so only the account owner can make a machine update itself, not the relay. */
export interface UpdateOrder {
  version: string
  issuedAt: string
}
/** Sealed by the app: send the end of your log. It names its machine and is recent, like start orders. */
export interface LogRequest {
  requestId: string
  machineId: string
  issuedAt: string
}
/** Sealed by the agent: the end of its log, for the request it names. Never what Claude wrote, and without secrets. */
export interface AgentLog {
  requestId: string
  machineId: string
  /** The last lines, oldest first. */
  lines: string[]
  /** Earlier lines were left out. */
  truncated: boolean
  /** Of the whole log file, in bytes. */
  size: number
  at: string
  /** Why the agent sent no lines. */
  error?: string
}
/** What the app can ask a machine to repair, from Settings › Machines: each one redoes a part of the install step. */
export type SetupFix = 'service' | 'hooks' | 'mcp' | 'launcher' | 'statusline' | 'opencode'
/** Sealed by the app: check how this machine is set up, after one repair if `fix` names it. Recent, and names its machine. */
export interface DiagnoseRequest {
  requestId: string
  machineId: string
  issuedAt: string
  fix?: SetupFix
}
/** One line of a diagnosis. */
export interface SetupCheck {
  /** `agent`, `service`, `relay`, `hooks`, `mcp`, `launcher`, `statusline` or `opencode`. Newer agents may add others. */
  id: string
  /** Shown as is, so an app can show a check it does not know. */
  label: string
  ok: boolean
  detail: string
  /** A repair the app can ask for. */
  fix?: SetupFix
}
/** Sealed by the agent: how the machine is set up, for the request it names. */
export interface Diagnosis {
  requestId: string
  machineId: string
  at: string
  /** The agent installed on the machine. */
  version: string
  checks: SetupCheck[]
  /** What the repair the request asked for did. */
  fixed?: { fix: SetupFix; ok: boolean; text: string }
  /** Why the agent ran no check. */
  error?: string
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
  /** Sealed `SessionName`, once a Mac renamed the session. Older relays leave it out. */
  name?: Sealed | null
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
  // A read-only share of the session: `info` is a `SharedInfo`, it and the entries sealed with the share key.
  | { t: 'share_info'; sessionId: string; shareId: string; info: Sealed }
  | { t: 'share_entries'; sessionId: string; shareId: string; entries: SealedEntry[]; reset: boolean }
  // The answer to a `LogRequest`: a sealed `AgentLog`.
  | { t: 'agent_logs'; requestId: string; logs: Sealed }
  // The answer to a `DiagnoseRequest`: a sealed `Diagnosis`.
  | { t: 'diagnosis'; requestId: string; diagnosis: Sealed }

// relay -> agent
export type RelayToAgent =
  | { t: 'prompt'; sessionId: string; payload: Sealed }
  // `rule`: a `SessionRules` sealed by the app, when the user allowed this kind of call for the rest of the session.
  | { t: 'verdict'; sessionId: string; requestId: string; behavior: 'allow' | 'deny'; rule?: Sealed }
  | { t: 'update'; order: Sealed }
  // The machine's auto-approve rules, sealed `RuleSet`: on each connection, and when the app changes them.
  | { t: 'rules'; rules: Sealed }
  | { t: 'start_session'; launchId: string; order: Sealed }
  | { t: 'start_answer'; launchId: string; answer: Sealed }
  // A `ShareOrder` sealed by the app: to the session's channel when the app shares it, and again when the channel connects.
  | { t: 'share'; sessionId: string; shareId: string; order: Sealed }
  // The share was revoked or expired: stop sealing for it.
  | { t: 'unshare'; sessionId: string; shareId: string }
  // A sealed `LogRequest`.
  | { t: 'agent_logs'; requestId: string; request: Sealed }
  // A sealed `DiagnoseRequest`.
  | { t: 'diagnose'; requestId: string; request: Sealed }

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
  // The sealed `AgentLog` of a machine, or `reason` when the relay could not reach it.
  | { t: 'agent_logs'; machineId: string; requestId: string; reason?: 'offline'; logs?: Sealed | null }
  // The sealed `Diagnosis` of a machine, or `reason` when the relay could not reach it.
  | { t: 'diagnosis'; machineId: string; requestId: string; reason?: 'offline'; diagnosis?: Sealed | null }

// app -> relay
export type AppMessage =
  | { t: 'subscribe'; sessionId: string | null }
  | { t: 'prompt'; sessionId: string; payload: Sealed }
  | { t: 'verdict'; sessionId: string; requestId: string; behavior: 'allow' | 'deny'; rule?: Sealed }
  | { t: 'dismiss'; sessionId: string }
  // A sealed `SessionName`: the relay keeps it with the session and sends it to every app of the account.
  | { t: 'rename'; sessionId: string; name: Sealed }
  | { t: 'update_agent'; machineId: string; order: Sealed }
  | { t: 'rules'; machineId: string; rules: Sealed }
  | { t: 'start_session'; machineId: string; launchId: string; order: Sealed }
  | { t: 'start_answer'; machineId: string; launchId: string; answer: Sealed }
  // After `POST /api/shares` made the share: its order, for the session's agent.
  | { t: 'share'; sessionId: string; shareId: string; order: Sealed }
  | { t: 'agent_logs'; machineId: string; requestId: string; request: Sealed }
  | { t: 'diagnose'; machineId: string; requestId: string; request: Sealed }

// relay -> viewer (/ws/share, with a share token): one session, read only.
export type RelayToViewer =
  | { t: 'shared'; status: SessionStatus; info: Sealed | null; entries: SealedEntry[] }
  | { t: 'shared_info'; info: Sealed }
  | { t: 'shared_entries'; entries: SealedEntry[]; reset: boolean }
  | { t: 'shared_status'; status: SessionStatus }
  // Revoked or expired: the socket closes after it.
  | { t: 'share_ended' }

// Push notifications to the iPhone app, from a relay that holds an APNs key (TONTON_APNS_*, off by default). Apple only
// ever carries ids, states and blobs sealed by the agents: the phone opens them with the account key.

/** POST /api/push/devices (app -> relay): what one install of the iPhone app wants pushed, sent again on each change. */
export interface PushDevice {
  /** Random, made by the app once per install. */
  device: string
  environment: 'sandbox' | 'production'
  /** APNs device token, hex: permission requests are pushed to it. Null: no alerts. */
  alert: string | null
  /** Push token of the Live Activity running on the phone, hex. Null: none runs. */
  activity: string | null
  /** Token that lets the relay start a Live Activity (iOS 17.2 and later), hex. Null: none. */
  activityStart: string | null
}

/** The answer to GET /api/push and POST /api/push/devices. Older relays answer 404. */
export interface PushStatus {
  /** False when the relay has no APNs key: the phone only sees the sessions while it is open. */
  enabled: boolean
}

/** Sent next to the content-free text of a permission alert, under `tonton`. */
export interface PermissionPush {
  sessionId: string
  requestId: string
  /** The sealed `PermissionDetail`, left out when the alert would not fit. */
  request?: Sealed
  /** The session's sealed `SessionInfo`, likewise. */
  info?: Sealed
}

/** The content state of the Live Activity: set by the phone while it runs, pushed by the relay otherwise. */
export interface IslandState {
  /** Those that need the user first, then the latest at work, then the latest done. At most 3. */
  sessions: IslandSession[]
  /** Sessions working or starting. */
  working: number
  /** Sessions asking for a permission, waiting for the user or stopped by an error. */
  attention: number
}
export interface IslandSession {
  id: string
  status: SessionStatus
  /** The sealed `SessionInfo`, null when unknown or too long to push. */
  info: Sealed | null
  /** The sealed `StatusDetail`, likewise. */
  detail: Sealed | null
}
