// Checks the plaintext of sealed fields before a client uses it, the way the Mac app's Codable types do: a required field
// that is missing, or any field of the wrong type, and the whole payload is dropped. Unknown fields are ignored, so newer
// agents can add some.

import type {
  AgentLog,
  Diagnosis,
  Entry,
  FileEdit,
  ImageData,
  MachineHealth,
  PermissionDetail,
  SessionInfo,
  SessionMeta,
  SessionName,
  StartDetail,
  StatusDetail,
  TokenCounts,
  UsageLimit,
} from './protocol'

type Fields = Record<string, unknown>

class Invalid extends Error {}

const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value)

function fields(value: unknown): Fields {
  if (!isFields(value)) throw new Invalid()
  return value
}

/** Absent and null are the same, like `decodeIfPresent`. */
function optional<T>(value: unknown, read: (value: unknown) => T): T | undefined {
  return value === undefined || value === null ? undefined : read(value)
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new Invalid()
  return value
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Invalid()
  return value
}

function integer(value: unknown): number {
  if (!Number.isInteger(value)) throw new Invalid()
  return value as number
}

function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Invalid()
  return value
}

function list<T>(value: unknown, read: (value: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Invalid()
  return value.map(read)
}

/** Drops the keys left undefined, so a decoded payload compares equal to one written without them. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T
}

/** Runs a reader on an untrusted value: null when it does not have the expected shape. */
function decoder<T>(read: (value: Fields) => T): (value: unknown) => T | null {
  return value => {
    try {
      return read(fields(value))
    } catch (error) {
      if (error instanceof Invalid) return null
      throw error
    }
  }
}

const image = (value: unknown): ImageData => {
  const f = fields(value)
  return { mediaType: text(f.mediaType), data: text(f.data) }
}

const edit = (value: unknown): FileEdit => {
  const f = fields(value)
  return { oldText: text(f.oldText), newText: text(f.newText) }
}

const usageLimit = (value: unknown): UsageLimit => {
  const f = fields(value)
  return { usedPercent: number(f.usedPercent), resetsAt: text(f.resetsAt) }
}

const tokenCounts = (value: unknown): TokenCounts => {
  const f = fields(value)
  return { input: integer(f.input), output: integer(f.output), cacheRead: integer(f.cacheRead), cacheWrite: integer(f.cacheWrite) }
}

export const decodeSessionName = decoder(
  (f): SessionName => ({ sessionId: text(f.sessionId), name: text(f.name), issuedAt: text(f.issuedAt) }),
)

export const decodeSessionInfo = decoder(
  (f): SessionInfo =>
    compact({
      machine: text(f.machine),
      platform: optional(f.platform, text),
      cwd: text(f.cwd),
      project: text(f.project),
      tool: optional(f.tool, text) as SessionInfo['tool'],
    }),
)

export const decodeSessionMeta = decoder(
  (f): SessionMeta =>
    compact({
      title: optional(f.title, text),
      costUSD: optional(f.costUSD, number),
      tokens: optional(f.tokens, tokenCounts),
      context: optional(f.context, value => {
        const c = fields(value)
        return compact({ usedTokens: integer(c.usedTokens), windowTokens: optional(c.windowTokens, integer) })
      }),
      lastMessage: optional(f.lastMessage, text),
      fiveHourLimit: optional(f.fiveHourLimit, usageLimit),
      sevenDayLimit: optional(f.sevenDayLimit, usageLimit),
      terminal: optional(f.terminal, flag),
      // Names this client does not know are kept here; the vault drops them.
      commands: optional(f.commands, value => list(value, text)) as SessionMeta['commands'],
      model: optional(f.model, text),
    }),
)

export const decodeStatusDetail = decoder((f): StatusDetail => ({ text: text(f.text) }))

export const decodePermissionDetail = decoder(
  (f): PermissionDetail => ({ toolName: text(f.toolName), description: text(f.description), inputPreview: text(f.inputPreview) }),
)

export const decodeMachineName = decoder((f): { name: string; platform?: string } =>
  compact({ name: text(f.name), platform: optional(f.platform, text) }),
)

export const decodeMachineHealth = decoder(
  (f): MachineHealth =>
    compact({
      cpu: number(f.cpu),
      memoryUsed: number(f.memoryUsed),
      memoryTotal: number(f.memoryTotal),
      battery:
        optional(f.battery, value => {
          const b = fields(value)
          return { percent: integer(b.percent), charging: flag(b.charging) }
        }) ?? null,
      wake: optional(f.wake, value =>
        list(value, target => {
          const t = fields(target)
          return { mac: text(t.mac), broadcast: text(t.broadcast) }
        }),
      ),
      // Names this client does not know are kept: a newer agent may start other tools.
      tools: optional(f.tools, value => list(value, text)) as MachineHealth['tools'],
      at: text(f.at),
    }),
)

export const decodeStartDetail = decoder(
  (f): StartDetail =>
    compact({
      launchId: text(f.launchId),
      machineId: text(f.machineId),
      // The app takes any state and goes by the ones it knows.
      state: text(f.state) as StartDetail['state'],
      text: optional(f.text, text),
      question: optional(f.question, text),
      sessionId: optional(f.sessionId, text),
    }),
)

export const decodeAgentLog = decoder(
  (f): AgentLog =>
    compact({
      requestId: text(f.requestId),
      machineId: text(f.machineId),
      lines: list(f.lines, text),
      truncated: flag(f.truncated),
      size: integer(f.size),
      at: text(f.at),
      error: optional(f.error, text),
    }),
)

/** Checks and repairs are named by the agent: the ones this client does not know are kept as they are. */
export const decodeDiagnosis = decoder(
  (f): Diagnosis =>
    compact({
      requestId: text(f.requestId),
      machineId: text(f.machineId),
      at: text(f.at),
      version: text(f.version),
      checks: list(f.checks, value => {
        const c = fields(value)
        return compact({
          id: text(c.id),
          label: text(c.label),
          ok: flag(c.ok),
          detail: text(c.detail),
          fix: optional(c.fix, text) as Diagnosis['checks'][number]['fix'],
        })
      }),
      fixed: optional(f.fixed, value => {
        const r = fields(value)
        return { fix: text(r.fix) as NonNullable<Diagnosis['fixed']>['fix'], ok: flag(r.ok), text: text(r.text) }
      }),
      error: optional(f.error, text),
    }),
)

/**
 * A conversation entry. The app reads every field as optional but the kind, so fields missing from an entry of a given
 * kind get an empty value here rather than dropping the entry.
 */
export const decodeEntry = decoder((f): Entry => {
  const base = { id: text(f.id), ts: text(f.ts) }
  const body = optional(f.text, text)
  const images = optional(f.images, value => list(value, image))
  const toolUseId = optional(f.toolUseId, text) ?? ''
  // Read even where a kind does not use them: a field of the wrong type fails the entry in the app too.
  const viaNotch = optional(f.viaNotch, flag)
  const name = optional(f.name, text)
  const summary = optional(f.summary, text)
  const isError = optional(f.isError, flag)
  const edits = optional(f.edits, value => list(value, edit))
  switch (f.kind) {
    case 'user':
      return compact({ ...base, kind: 'user', text: body ?? '', images, viaNotch })
    case 'assistant':
      return { ...base, kind: 'assistant', text: body ?? '' }
    case 'system':
      return { ...base, kind: 'system', text: body ?? '' }
    case 'tool':
      return compact({ ...base, kind: 'tool', toolUseId, name: name ?? '', summary: summary ?? '', edits })
    case 'tool_result':
      return compact({ ...base, kind: 'tool_result', toolUseId, text: body ?? '', isError: isError ?? false, images })
    default:
      throw new Invalid()
  }
})
