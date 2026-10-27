// Turns the relay's sealed messages into readable models, and seals what a client sends back. The TypeScript twin of
// app/Sources/TontonCore/SessionVault.swift: fields that do not open (another key, corrupted or unexpected data) degrade
// to placeholders instead of failing.

import { type AccountKey, open, seal } from './crypto'
import {
  decodeAgentLog,
  decodeDiagnosis,
  decodeEntry,
  decodeMachineHealth,
  decodeMachineName,
  decodePermissionDetail,
  decodeSessionInfo,
  decodeSessionMeta,
  decodeStartDetail,
  decodeStatusDetail,
} from './payloads'
import type {
  AgentLog,
  DiagnoseRequest,
  Diagnosis,
  Entry,
  LogRequest,
  MachineSummary,
  ModelAlias,
  PermissionRule,
  PromptPayload,
  Sealed,
  SealedEntry,
  SessionCommand,
  SessionRules,
  SessionSummary,
  SetupFix,
  StartDetail,
  UsageLimit,
} from './protocol'
import {
  COMMANDS,
  contextWindow,
  type Machine,
  ORIGINAL_COMMANDS,
  type PermissionRequest,
  parseDate,
  type Session,
  type UsageWindow,
} from './session'

export interface OutgoingImage {
  name: string
  mediaType: string
  /** Base64. */
  data: string
}

export class Vault {
  constructor(private readonly key: AccountKey) {}

  async session(wire: SessionSummary, machines: readonly Machine[]): Promise<Session> {
    const [info, meta, status, permissions] = await Promise.all([
      this.read(wire.info, decodeSessionInfo),
      this.read(wire.meta, decodeSessionMeta),
      this.read(wire.statusDetail, decodeStatusDetail),
      Promise.all((Array.isArray(wire.pendingPermissions) ? wire.pendingPermissions : []).map(p => this.permission(p))),
    ])
    return {
      id: wire.id,
      machineId: wire.machineId,
      machine: info?.machine ?? machines.find(m => m.id === wire.machineId)?.name ?? 'Unknown machine',
      platform: info?.platform ?? null,
      cwd: info?.cwd ?? '',
      project: info?.project ?? 'Encrypted session',
      title: meta?.title ?? null,
      status: wire.status,
      statusText: status?.text ?? null,
      agentOnline: wire.agentOnline === true,
      canChat: wire.canChat === true,
      pendingPermissions: permissions.filter((p): p is PermissionRequest => p !== null),
      costUSD: meta?.costUSD ?? null,
      tokens: meta?.tokens ?? null,
      context: meta?.context ? contextWindow(meta.context.usedTokens, meta.context.windowTokens) : null,
      startedAt: parseDate(wire.startedAt),
      lastActivity: parseDate(wire.lastActivity),
      lastMessage: meta?.lastMessage ?? null,
      fiveHourLimit: usageWindow(meta?.fiveHourLimit),
      sevenDayLimit: usageWindow(meta?.sevenDayLimit),
      terminal: meta?.terminal ?? false,
      // Older agents type the original commands in tmux only, and never interrupt.
      commands: meta?.commands ? COMMANDS.filter(name => meta.commands?.includes(name)) : meta?.terminal ? [...ORIGINAL_COMMANDS] : [],
      model: meta?.model ?? null,
      tool: info?.tool ?? null,
    }
  }

  machines(wire: readonly MachineSummary[]): Promise<Machine[]> {
    return Promise.all(
      wire.map(async (machine): Promise<Machine> => {
        const [name, health] = await Promise.all([
          this.read(machine.name, decodeMachineName),
          this.read(machine.health, decodeMachineHealth),
        ])
        return {
          id: machine.id,
          name: name?.name ?? 'Unknown machine',
          platform: name?.platform ?? null,
          createdAt: parseDate(machine.createdAt),
          lastSeen: parseDate(machine.lastSeen),
          online: machine.online === true,
          agentVersion: typeof machine.agentVersion === 'string' ? machine.agentVersion : null,
          health,
        }
      }),
    )
  }

  /** The entries that open, in order. */
  async entries(wire: readonly SealedEntry[]): Promise<Entry[]> {
    const opened = await Promise.all(wire.map(entry => this.read(entry?.blob, decodeEntry)))
    return opened.filter((entry): entry is Entry => entry !== null)
  }

  sealPrompt(text: string, images: readonly OutgoingImage[] = []): Promise<Sealed> {
    const payload: PromptPayload = { text, images: [...images] }
    return seal(this.key, payload)
  }

  /**
   * A slash command for the session's terminal, sent like a message. Its random id lets the agent run it once. `model`
   * goes with the `model` command only.
   */
  sealCommand(name: SessionCommand['name'], sessionId: string, options: { model?: ModelAlias; issuedAt?: Date } = {}): Promise<Sealed> {
    const issuedAt = (options.issuedAt ?? new Date()).toISOString()
    const command: SessionCommand = {
      name,
      sessionId,
      id: crypto.randomUUID(),
      issuedAt,
      ...(name === 'model' && options.model ? { model: options.model } : {}),
    }
    const payload: PromptPayload = { text: '', images: [], command }
    return seal(this.key, payload)
  }

  /** "Allow for this session": the rules go with the verdict, bound to its session and request. */
  sealSessionRules(sessionId: string, requestId: string, rules: PermissionRule[]): Promise<Sealed> {
    const payload: SessionRules = { sessionId, requestId, rules }
    return seal(this.key, payload)
  }

  startDetail(blob: Sealed | null | undefined): Promise<StartDetail | null> {
    return this.read(blob, decodeStartDetail)
  }

  /** Asks a machine for the end of its agent log. It names the machine, and agents refuse old ones. */
  sealLogRequest(requestId: string, machineId: string, issuedAt = new Date()): Promise<Sealed> {
    const request: LogRequest = { requestId, machineId, issuedAt: issuedAt.toISOString() }
    return seal(this.key, request)
  }

  agentLog(blob: Sealed | null | undefined): Promise<AgentLog | null> {
    return this.read(blob, decodeAgentLog)
  }

  /** Asks a machine to check how it is set up, after the repair `fix` names. Like log requests, it names the machine. */
  sealDiagnoseRequest(requestId: string, machineId: string, fix?: SetupFix, issuedAt = new Date()): Promise<Sealed> {
    const request: DiagnoseRequest = { requestId, machineId, issuedAt: issuedAt.toISOString(), ...(fix ? { fix } : {}) }
    return seal(this.key, request)
  }

  diagnosis(blob: Sealed | null | undefined): Promise<Diagnosis | null> {
    return this.read(blob, decodeDiagnosis)
  }

  /** The text of a sealed `{ text }` detail, such as the reason an agent update failed. */
  async detailText(blob: Sealed | null | undefined): Promise<string | null> {
    return (await this.read(blob, decodeStatusDetail))?.text ?? null
  }

  private async permission(wire: SessionSummary['pendingPermissions'][number]): Promise<PermissionRequest | null> {
    const detail = await this.read(wire?.blob, decodePermissionDetail)
    return detail && { requestId: wire.requestId, ...detail, ts: wire.ts }
  }

  private async read<T>(blob: unknown, decode: (value: unknown) => T | null): Promise<T | null> {
    if (typeof blob !== 'string') return null
    try {
      return decode(await open<unknown>(this.key, blob))
    } catch {
      return null
    }
  }
}

function usageWindow(limit: UsageLimit | undefined): UsageWindow | null {
  const resetsAt = parseDate(limit?.resetsAt)
  return limit && resetsAt !== null ? { usedPercent: limit.usedPercent, resetsAt } : null
}
