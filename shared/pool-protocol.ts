// Pools: several accounts whose Claude Code sessions build one project together (docs/pools.md). What the relay keeps
// in clear is ids, roles, revisions, sizes and times; everything that says what the pool does is sealed with the pool
// key, which the members share and the relay never gets. Mirrors app/Sources/TontonCore/Pool.swift.

import type { PoolKeyWrapWire } from './pool-keys'
import type { PermissionRule, Sealed, SessionStatus } from './protocol'

export type { PoolKeyWrapWire } from './pool-keys'

export type PoolRole = 'owner' | 'admin' | 'member' | 'viewer'

/** Who did something in a pool: an account, and the pool session it spoke from, if any. */
export interface PoolAuthor {
  account: string
  /** Null when it came from an app or the website rather than a session. */
  session: string | null
  /**
   * The pool machine whose agent service wrote it (docs/pool-autopilot.md), attested by the relay from the socket it
   * came on. Missing for apps, the website and sessions, and from older relays.
   */
  machine?: string
}

// Plaintext payloads, sealed with the pool key.

export interface PoolInfo {
  name: string
  /** What the pool builds, for the orchestrator and every member. */
  goal?: string
  /** `hackathon`: a pool against a deadline (docs/pools.md, Hackathon mode). Missing: an ordinary pool. */
  template?: 'hackathon'
  /** The repository the pool works on, as a URL or a path. */
  repo?: string
  /** ISO date and time the work must be done by. */
  deadline?: string
  /** ISO date and time the countdown started: when the pool was made. */
  startedAt?: string
}

/** How a member shows in the pool. */
export interface PoolMemberProfile {
  name: string
}

/** What a pool session is for, as its owner set it when it joined. */
export interface PoolSessionProfile {
  /** `front`, `back`, `infra`, `tests`, `docs`, `review`, or anything else. */
  area?: string
  /** What it knows, in a few words. */
  skills?: string
  /** The repository folder it works in. */
  repo?: string
  project?: string
  machine?: string
  tool?: 'claude' | 'opencode'
  /** Older profiles only: the orchestrator is now the pool's `orchestrator` field, which only owners and admins set. */
  orchestrator?: boolean
  /**
   * The kind of task its owner gives it: `simple` (tests, docs, small fixes, boilerplate) or `large` (features that need
   * broad context). Missing: by its tool, simple for OpenCode and large for Claude Code (docs/pools.md, Sizes of work).
   */
  takes?: PoolTaskSize
}

/** `simple`: tests, docs, small fixes, boilerplate, a page that follows an existing pattern. `large`: a feature, an area. */
export type PoolTaskSize = 'simple' | 'large'
/** How capable a model a task needs (shared/pool-model.ts): the owner of each machine says which model each tier is. */
export type ModelTier = 'light' | 'balanced' | 'strong'

export type PoolTaskState = 'todo' | 'assigned' | 'in_progress' | 'review' | 'done' | 'blocked'

export interface PoolTask {
  title: string
  goal?: string
  /** What "done" means. */
  criteria?: string[]
  area?: string
  state: PoolTaskState
  assignee?: { account: string; session: string }
  /** Ids of the tasks it waits for. */
  dependsOn?: string[]
  /** `pool/<id>-<slug>`: the branch the work goes on, one per task. */
  branch?: string
  /** What was done, when it is done or blocked. */
  summary?: string
  /** Missing: `large`. Decides who the orchestrator hands it to. */
  size?: PoolTaskSize
  /** The files and folders the task works in, from its area. */
  paths?: string[]
  /** How long it should take, in hours. Missing: by its size, 1 for small and 3 for large (docs/pools.md). */
  hours?: number
  /** In review: the session checking it. The assignee stays its author. */
  reviewer?: { account: string; session: string }
  /** What the last review said: why it was sent back, or what the reviewer noted when accepting it. */
  review?: string
  /**
   * Dispatched to this pool machine (docs/pool-autopilot.md): its agent starts a session for the task, which then
   * becomes `assignee`. Kept apart from `assignee`, which names a session, so that older clients still read the task.
   */
  machine?: PoolMachineRef
  /** How many times the task went back to `todo` because its machine or its session failed it. Missing: none. */
  attempts?: number
  /** What became of its branch when the orchestrator merged it into main (docs/pool-orchestrator.md, Merging). */
  merge?: PoolTaskMerge
  /** The tier the orchestrator or an admin set for it, over the assessment. A machine owner's lock still wins. */
  model?: ModelTier
  /**
   * How many times a session failed the task itself: it ended before the task was done, stalled, or the branch it
   * finished fails main's checks. Not a machine going offline or a session that could not start. Missing: none.
   */
  setbacks?: number
  /** The model its machine started its session on, and why (shared/pool-model.ts). */
  route?: PoolTaskRoute
}

/** What a pool machine chose for a task's session. Every field is optional for the apps, which only show it. */
export interface PoolTaskRoute {
  tier?: ModelTier
  /** What the session was started or switched with: `sonnet`, `claude-sonnet-4-5`, `anthropic/claude-haiku-4-5`. */
  model?: string
  reason?: string
  /** Tiers it climbed after sessions failed the task. */
  escalated?: number
  /** The model the session reported running on, once it did. */
  confirmed?: string
  /** Why the model could not be applied or confirmed: the session runs on what its tool chose. */
  problem?: string
  at?: string
}

/**
 * `merged`: on main. `pr`: a pull request is open for it. `conflict`: it does not merge with main. `failed`: merged with
 * main, a check fails. The last two send the task back to its author, or to a new task named in `fix`.
 */
export type PoolTaskMergeState = 'merged' | 'pr' | 'conflict' | 'failed'

export interface PoolTaskMerge {
  state: PoolTaskMergeState
  /** ISO time of the attempt. */
  at: string
  /** `merged`: the commit main points to with it. */
  commit?: string
  /** `pr`: the pull request's address. */
  url?: string
  /** `conflict`: the files that conflict. */
  files?: string[]
  /** `failed`: the check that fails. */
  command?: string
  /** `conflict` and `failed`: the end of what git or the check printed. */
  output?: string
  /** The task made to fix it, when its author could not take it back. */
  fix?: string
}

/** An area of the code and the paths it owns, so two sessions rarely edit the same files. */
export interface PoolArea {
  name: string
  paths: string[]
}

/** The sections of the shared notes, each replaced on its own. */
export type PoolNotesSection = 'goal' | 'stack' | 'contracts' | 'decisions'

export interface PoolNotes {
  /** Free text, for anything the sections do not hold. Older clients read and write only this. */
  text: string
  sections?: Partial<Record<PoolNotesSection, string>>
  areas?: PoolArea[]
}

export interface PoolMessageBody {
  text: string
  /** Missing: everyone. Otherwise one session, or every session of an area. */
  to?: { session?: { account: string; session: string }; area?: string }
}

export interface PoolEventBody {
  /**
   * `joined`, `task_moved`, `merged`, `blocked`… `session`: what a pool session runs on, posted by its agent. `usage`:
   * what the session spent and how much of its account's windows is left, posted by its agent when it changes.
   */
  kind: string
  text?: string
  taskId?: string
  /** `session` events: the coding tool and the model, so the orchestrator assigns by capability. */
  tool?: 'claude' | 'opencode'
  model?: string
  /** `usage` events. */
  usage?: PoolUsage
  /** `spend` events: what the session spent since it joined the pool, as its agent counts it. */
  costUSD?: number
  seconds?: number
  /** `limits` events: the account's plan usage, as the session's agent last read it. Claude Code only. */
  limits?: PoolLimits
}

/**
 * A pool session's tokens and its account's windows, for the control center, the leaderboard and the orchestrator. What
 * it spent goes in `spend` events, which the budgets count.
 */
export interface PoolUsage {
  tokens?: { input: number; output: number }
  /** Claude Code only: OpenCode has no plan limits. */
  fiveHour?: { usedPercent: number; resetsAt?: string }
  sevenDay?: { usedPercent: number; resetsAt?: string }
}

/**
 * Auto-approve rules the owner or an admin proposes for the pool's sessions. A proposal does nothing by itself: each
 * machine owner accepts it for a session, and only what they accepted reaches that session's agent (`PoolRulesAcceptance`).
 */
export interface PoolRules {
  rules: PermissionRule[]
  /** Why, in a few words. */
  note?: string
}

/** A spending cap: cost at list price, time Claude worked. Missing: no cap. */
export interface PoolBudget {
  costUSD?: number
  hours?: number
}

/** Set by the owner and admins. Each agent counts its own session and stops taking pool tasks past a cap. */
export interface PoolBudgets {
  /** The whole pool. */
  pool?: PoolBudget
  /** Each member, all its sessions together, unless `members` names it. */
  member?: PoolBudget
  /** One member, by account. */
  members?: Record<string, PoolBudget>
}

/** A window of a Claude plan: how much of it is used, and when it starts over. */
export interface PoolLimitWindow {
  /** 0 to 100. */
  usedPercent: number
  resetsAt: string
}

/** What a Claude Code session shares of its account's plan, so the orchestrator plans around it. */
export interface PoolLimits {
  fiveHour?: PoolLimitWindow
  sevenDay?: PoolLimitWindow
  /** When the 5-hour window runs out at the current pace (shared/limit-forecast.ts). Missing: not before it resets. */
  runsOutAt?: string
}

/**
 * What the sessions a pool machine starts may do without asking. `ask`: every permission prompt goes to the machine
 * owner, as for any session. `edits`: file edits and read-only tools pass, the rest asks. `full`: everything passes,
 * only for a machine or a VM given to the work. The machine owner's choice, never the pool's.
 */
export type PoolMachineMode = 'ask' | 'edits' | 'full'

/** A whole machine a member put in the pool (docs/pool-autopilot.md), as the members see it. */
export interface PoolMachineProfile {
  /** The machine's name, as its owner calls it. */
  name?: string
  /** What its sessions run. */
  tool: 'claude' | 'opencode'
  /** How many sessions it runs at once for the pool, 1 to 8. */
  capacity: number
  /** The folder on the machine the pool's work goes in: the repository in `repo`, a git worktree per task in `tasks`. */
  workdir: string
  mode: PoolMachineMode
  /** As for sessions: simple or large tasks. Missing: by its tool. */
  takes?: PoolTaskSize
  /** The areas it prefers (front, back…). */
  areas?: string[]
  /** Which models its sessions run on (shared/pool-model.ts). Missing: each task gets the tier it needs. */
  models?: PoolModelPolicy
}

/** The machine owner's choice of models for the pool's tasks. */
export interface PoolModelPolicy {
  /** Every task runs on this tier, whatever it is: nothing overrides it. */
  lock?: ModelTier
  /** The tiers its sessions may use. Missing: all three. */
  allowed?: ModelTier[]
  /** The model each tier stands for: a Claude Code alias or id, an OpenCode `provider/model`. Missing: haiku, sonnet, opus. */
  tiers?: Partial<Record<ModelTier, string>>
  /** How many tiers a task may climb after sessions failed it, 0 to 2. Missing: 1. */
  escalations?: number
}

/** Whether the control loop hands out the pool's tasks (`dispatch_start`, `dispatch_stop`, or the website). */
export interface PoolDispatch {
  on: boolean
  /** Why, in a few words. */
  note?: string
}

// Sealed with the account key: what a member keeps for itself.

/** A member's own copy of the pool key, kept on the relay so its other devices and its machines' agents get it. */
export interface PoolKeyGrant {
  poolId: string
  /** Base64url AES-256 key. */
  key: string
  version: number
}

/** From the member's app to one of its sessions' agents: work for this pool, with its key. */
export interface PoolSessionOrder {
  poolId: string
  sessionId: string
  key: string
  version: number
  issuedAt: string
  /**
   * The machine owner's choice: start a pool task as soon as it is assigned, or tell the user first and wait for them.
   * Missing: ask first.
   */
  autoStart?: boolean
  /**
   * Set by a pool machine's agent service for a session it started (docs/pool-autopilot.md): the machine, and the mode
   * its owner chose in that machine's order. Missing for sessions put in the pool by hand.
   */
  machine?: string
  mode?: PoolMachineMode
}

/**
 * From the machine owner's app or the website to the machine's agent service: work for this pool, with its key. It
 * names the machine, so the relay cannot move it to another one. What the agent applies (its folder, its mode) comes
 * from here, sealed with the account key, never from the profile the pool sees.
 */
export interface PoolMachineOrder {
  poolId: string
  machineId: string
  key: string
  version: number
  issuedAt: string
  profile: PoolMachineProfile
}

/**
 * From a machine owner's app to its session's agent: apply these pool rules, exactly these, in this session. The rules
 * are copied in, so the relay can neither swap the proposal nor hand the acceptance to another session.
 */
export interface PoolRulesAcceptance {
  poolId: string
  sessionId: string
  /** The revision of the proposal that was accepted. */
  rev: number
  rules: PermissionRule[]
  issuedAt: string
}

// What the relay sends: clear fields and sealed blobs.

export interface PoolSummary {
  id: string
  /** The role of the account asking. */
  role: PoolRole
  createdAt: string
  paused: boolean
  keyVersion: number
  /** `PoolInfo`, sealed with the pool key. */
  info: Sealed
  /** `PoolKeyGrant`, sealed with the account key: the version of the key this member joined with. */
  key: Sealed
  members: number
  /** `PoolMemberSecret`, sealed with the account key: the member's private key for the pool. Null for older members. */
  secret: Sealed | null
  /** The later versions of the pool key, wrapped for this member by the admins who rotated it. */
  wraps: PoolKeyWrapWire[]
}

export interface PoolMemberWire {
  account: string
  role: PoolRole
  joinedAt: string
  /** `PoolMemberProfile`, sealed with the pool key. */
  profile: Sealed | null
  /**
   * `PoolMemberKey`, sealed with each version of the pool key it was published under, oldest first: what an admin wraps
   * a new pool key for. Every one holds the same public key; a reader opens whichever its keys allow.
   */
  publicKeys: Sealed[]
}

export interface PoolSessionWire {
  account: string
  session: string
  joinedAt: string
  /** `PoolSessionProfile`, sealed with the pool key. */
  profile: Sealed | null
  /** Its agent is connected. */
  online: boolean
  /** Its agent took the order and holds the pool key. */
  ready: boolean
  /** The session's status, which the relay sees anyway. Missing from older relays, and while it has none. */
  status?: SessionStatus
  /** The revision of the pool rules its owner accepted for it, 0 for none. Missing from older relays. */
  accepted?: number
  /** The pool machine whose agent started it, as the relay attests it. Missing for sessions joined by hand. */
  machine?: string
}

/** A pool machine, by its owner's account and its id. */
export interface PoolMachineRef {
  account: string
  machine: string
}

export interface PoolMachineWire extends PoolMachineRef {
  addedAt: string
  /** `PoolMachineProfile`, sealed with the pool key. */
  profile: Sealed | null
  /** The machine is connected to the relay, as Settings › Machines shows it. */
  online: boolean
  /** Its agent service took the order and holds the pool key. Online but never ready: its agent is older. */
  ready: boolean
  /** Its owner or an admin stopped it: it takes no work until one of them starts it again. Missing: it works. */
  stopped?: boolean
}

/** A task: its revision goes up with every change, so two members never overwrite each other unknowingly. */
export interface PoolTaskWire extends PoolAuthor {
  id: string
  rev: number
  updatedAt: string
  /** `PoolTask`. */
  blob: Sealed
}

export interface PoolNotesWire extends PoolAuthor {
  rev: number
  updatedAt: string
  /** `PoolNotes`. */
  blob: Sealed
}

/** A message or an event, in the order the relay got them. */
export interface PoolPostWire extends PoolAuthor {
  id: string
  seq: number
  ts: string
  /** `PoolMessageBody` or `PoolEventBody`. */
  blob: Sealed
}

/** The pool's rules or budgets: who set them last, and the sealed `PoolRules` or `PoolBudgets`. Same shape as the notes. */
export type PoolPolicyWire = PoolNotesWire

/** What the audit log records. The relay writes it in clear: it already knows each of these, as it enforces them. */
export type PoolAuditAction =
  | 'created'
  | 'joined'
  | 'left'
  | 'kicked'
  | 'role'
  | 'owner'
  | 'rotated'
  | 'invite_created'
  | 'invite_revoked'
  | 'session_joined'
  | 'session_left'
  | 'paused'
  | 'resumed'
  | 'stopped'
  | 'rules_proposed'
  | 'rules_accepted'
  | 'budgets_set'
  | 'machine_added'
  | 'machine_removed'
  | 'machine_stopped'
  | 'machine_started'
  | 'dispatch_set'

/** One line of the audit log: who did what, to whom, when. */
export interface PoolAuditWire extends PoolAuthor {
  seq: number
  ts: string
  action: PoolAuditAction
  /** `machine`: the pool machine it was about, missing from older relays. */
  target?: { account?: string; session?: string; machine?: string }
  /** The revision of the rules, the budgets or the dispatch, or the key version. */
  rev?: number
}

export interface PoolSnapshot {
  id: string
  createdAt: string
  paused: boolean
  keyVersion: number
  info: Sealed
  members: PoolMemberWire[]
  sessions: PoolSessionWire[]
  tasks: PoolTaskWire[]
  notes: PoolNotesWire | null
  /** The latest ones only, oldest first. */
  messages: PoolPostWire[]
  events: PoolPostWire[]
  /** For the account it is sent to: its private key for the pool and the later pool keys wrapped for it. */
  own?: { secret: Sealed | null; wraps: PoolKeyWrapWire[] }
  /** Missing from older relays. */
  rules?: PoolPolicyWire | null
  budgets?: PoolPolicyWire | null
  /** The latest lines of the audit log, oldest first. */
  audit?: PoolAuditWire[]
  /**
   * The one pool session that plans and assigns, set by an owner or an admin. In clear, like every id: the relay
   * attests it, so no member can make its own session the orchestrator. Missing from older relays.
   */
  orchestrator?: PoolSessionRef | null
  /** The machines members put in the pool. Missing from older relays. */
  machines?: PoolMachineWire[]
  /** The admin's machine whose agent runs the orchestrator session and the control loop. Missing from older relays. */
  orchestratorMachine?: PoolMachineRef | null
  /** The sealed `PoolDispatch`: whether the control loop hands out tasks. Missing from older relays. */
  dispatch?: PoolPolicyWire | null
}

export interface PoolSessionRef {
  account: string
  session: string
}

// app or agent -> relay. Agents add their `sessionId`; the relay attaches the sender to what it keeps.

export type PoolPost =
  /** `rev`: the revision it replaces, 0 for a new task. */
  | { t: 'pool_task'; poolId: string; id: string; rev: number; blob: Sealed }
  | { t: 'pool_notes'; poolId: string; rev: number; blob: Sealed }
  | { t: 'pool_message'; poolId: string; id: string; blob: Sealed }
  | { t: 'pool_event'; poolId: string; id: string; blob: Sealed }

export type PoolAppMessage =
  | PoolPost
  | { t: 'pool_subscribe'; poolId: string }
  | { t: 'pool_unsubscribe'; poolId: string }
  /** Owner and admins: a new sealed `PoolInfo`. */
  | { t: 'pool_info'; poolId: string; info: Sealed }
  /** Its own sealed `PoolMemberProfile`. */
  | { t: 'pool_profile'; poolId: string; profile: Sealed }
  /**
   * The account's own keys for the pool: `publicKey` a `PoolMemberKey` sealed with the pool key, `secret` a
   * `PoolMemberSecret` sealed with the account key. Sent again with the latest pool key after a rotation.
   */
  | { t: 'pool_member_key'; poolId: string; publicKey: Sealed; secret: Sealed }
  /** Puts one of the account's sessions in the pool: `order` is a `PoolSessionOrder` sealed with the account key. */
  | { t: 'pool_join_session'; poolId: string; sessionId: string; order: Sealed; profile: Sealed }
  | { t: 'pool_leave_session'; poolId: string; sessionId: string }
  /** Owner and admins: stop or let through the tasks and messages to the pool's sessions. */
  | { t: 'pool_pause'; poolId: string; paused: boolean }
  /** Owner and admins: stop one session's pool work, or every session's when `target` is null. A member stops its own. */
  | { t: 'pool_stop'; poolId: string; target: { account: string; session: string } | null }
  /** Owner and admins: a new sealed `PoolRules` proposal. `rev`: the revision it replaces, 0 at first. */
  | { t: 'pool_rules'; poolId: string; rev: number; blob: Sealed }
  /** Owner and admins: new sealed `PoolBudgets`. */
  | { t: 'pool_budgets'; poolId: string; rev: number; blob: Sealed }
  /** A machine owner, for one of its own sessions: a `PoolRulesAcceptance` sealed with its account key. */
  | { t: 'pool_accept_rules'; poolId: string; sessionId: string; rev: number; acceptance: Sealed }
  /** Owner and admins: make one of the pool's sessions the orchestrator, or none. */
  | { t: 'pool_orchestrator'; poolId: string; orchestrator: PoolSessionRef | null }
  /**
   * Puts one of the account's machines in the pool: `order` is a `PoolMachineOrder` sealed with the account key, `profile`
   * a `PoolMachineProfile` sealed with the pool key. Sent again, it replaces both.
   */
  | { t: 'pool_add_machine'; poolId: string; machineId: string; order: Sealed; profile: Sealed }
  /** The machine's owner, or the pool's owner and admins: takes a machine out, with the sessions it started. */
  | { t: 'pool_remove_machine'; poolId: string; machineId: string }
  /**
   * Stops a machine (`stopped`: its pool sessions end and its tasks go back to the board) or lets it work again. Its
   * owner, or the pool's owner and admins; `machine` null: every machine, the owner and admins only.
   */
  | { t: 'pool_stop_machine'; poolId: string; machine: string | null; stopped: boolean }
  /** Owner and admins: one of their own pool machines runs the orchestrator, or none. */
  | { t: 'pool_orchestrator_machine'; poolId: string; machine: PoolMachineRef | null }
  /** Owner and admins: a new sealed `PoolDispatch`. `rev`: the revision it replaces, 0 at first. */
  | { t: 'pool_dispatch'; poolId: string; rev: number; blob: Sealed }

export type PoolAgentMessage =
  | (PoolPost & { sessionId: string })
  /** The member's public key sealed with a newer pool key: agents hold the account key and can publish it too. */
  | { t: 'pool_member_key'; sessionId: string; poolId: string; publicKey: Sealed }
  /** The agent opened the order and holds the pool key. */
  | { t: 'pool_ack'; sessionId: string; poolId: string }
  /** The orchestrator session starts or stops the control loop: a sealed `PoolDispatch`. */
  | { t: 'pool_dispatch'; sessionId: string; poolId: string; rev: number; blob: Sealed }

/** A pool machine's agent service, on its own connection. The relay attaches the machine to what it keeps. */
export type PoolMachineMessage =
  /** Tasks, messages and events: the shared notes stay with the sessions and the members. */
  | (Exclude<PoolPost, { t: 'pool_notes' }> & { machineId: string })
  /** The service opened the machine's order and holds the pool key. */
  | { t: 'pool_machine_ack'; machineId: string; poolId: string }
  | { t: 'pool_member_key'; machineId: string; poolId: string; publicKey: Sealed }
  /**
   * Puts a session the service started on this machine in the pool: `order` is a `PoolSessionOrder` sealed with the
   * account key, `profile` a `PoolSessionProfile`. `orchestrator`: the orchestrator machine's session, which becomes the
   * pool's orchestrator.
   */
  | {
      t: 'pool_machine_session'
      machineId: string
      poolId: string
      sessionId: string
      order: Sealed
      profile: Sealed
      orchestrator?: boolean
    }
  /** Takes out a session this machine started: its task is done, or it ended. */
  | { t: 'pool_machine_session_left'; machineId: string; poolId: string; sessionId: string }
  /** The orchestrator machine's control loop stops itself: every task is done. */
  | { t: 'pool_dispatch'; machineId: string; poolId: string; rev: number; blob: Sealed }

// relay -> app, the website and the agents of pool sessions.

export type PoolUpdate =
  | { t: 'pool_snapshot'; pool: PoolSnapshot }
  | { t: 'pool_task'; poolId: string; task: PoolTaskWire }
  | { t: 'pool_notes'; poolId: string; notes: PoolNotesWire }
  | { t: 'pool_message'; poolId: string; message: PoolPostWire }
  | { t: 'pool_event'; poolId: string; event: PoolPostWire }
  | { t: 'pool_info'; poolId: string; info: Sealed; paused: boolean; keyVersion: number }
  /** `machine`: the orchestrator machine, missing from older relays. */
  | { t: 'pool_orchestrator'; poolId: string; orchestrator: PoolSessionRef | null; machine?: PoolMachineRef | null }
  | { t: 'pool_member'; poolId: string; member: PoolMemberWire }
  | { t: 'pool_member_left'; poolId: string; account: string }
  | { t: 'pool_session'; poolId: string; session: PoolSessionWire }
  | { t: 'pool_session_left'; poolId: string; account: string; session: string }
  | { t: 'pool_machine'; poolId: string; machine: PoolMachineWire }
  | { t: 'pool_machine_left'; poolId: string; account: string; machine: string }
  /** To one member only: the pool key was rotated, here is the new version wrapped for it. */
  | { t: 'pool_key'; poolId: string; wrap: PoolKeyWrapWire }
  | { t: 'pool_rules'; poolId: string; rules: PoolPolicyWire }
  | { t: 'pool_budgets'; poolId: string; budgets: PoolPolicyWire }
  | { t: 'pool_dispatch'; poolId: string; dispatch: PoolPolicyWire }
  | { t: 'pool_audit'; poolId: string; entry: PoolAuditWire }
  /** A change sent against an older revision was refused: here is the current one. */
  | {
      t: 'pool_conflict'
      poolId: string
      kind: 'task' | 'notes' | 'rules' | 'budgets' | 'dispatch'
      id?: string
      current: PoolTaskWire | PoolNotesWire | null
    }
  /** The account left, or the pool is gone. */
  | { t: 'pool_removed'; poolId: string }
  | { t: 'pool_error'; poolId: string; message: string }

// relay -> agent: a session joins or leaves a pool.
export type PoolToAgent =
  /** `acceptance`: the pool rules its owner accepted for it, a sealed `PoolRulesAcceptance`, when there are. */
  | { t: 'pool_join'; sessionId: string; poolId: string; order: Sealed; acceptance?: Sealed }
  | { t: 'pool_left'; sessionId: string; poolId: string }
  /** The owner or an admin stopped this session's pool work: interrupt the turn. `pool_left` follows. */
  | { t: 'pool_stop'; sessionId: string; poolId: string }
  /** Its owner accepted the pool rules for it, or newer ones. */
  | { t: 'pool_accept'; sessionId: string; poolId: string; acceptance: Sealed }

// relay -> a machine's agent service: the machine joins or leaves a pool.
export type PoolToMachine =
  /** `order`: a `PoolMachineOrder` sealed with the account key. Sent again whenever the service connects. */
  | { t: 'pool_machine_join'; machineId: string; poolId: string; order: Sealed }
  /** The machine is out of the pool: its sessions for it end. */
  | { t: 'pool_machine_leave'; machineId: string; poolId: string }
