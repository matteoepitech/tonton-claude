// Drives one Codex thread for the notch, next to its TUI on the same app-server (`tonton codex`): prompts with images,
// interrupt and compact, and the approvals Codex asks, which the notch, the iPhone and the website can answer. The TUI
// asks the same approvals: whichever answers first wins, and `serverRequest/resolved` tells the other.

import type { PermissionDetail } from '../../../shared/protocol'
import { log } from '../log'
import { CodexAppServer, type RequestId } from './app-server'

/** The approvals Tonton can answer. Others (`item/permissions/requestApproval`, questions) stay the TUI's. */
const COMMAND_APPROVALS = new Set(['item/commandExecution/requestApproval', 'execCommandApproval'])
const PATCH_APPROVALS = new Set(['item/fileChange/requestApproval', 'applyPatchApproval'])
/** The current names take `accept`; the older ones `approved`. */
const LEGACY = new Set(['execCommandApproval', 'applyPatchApproval'])

/** An approval Codex waits on, as the notch shows it and the auto-approve rules read it. */
export interface CodexApproval {
  requestId: string
  detail: PermissionDetail
  /** As Claude Code's tool input: `{ command }` for a shell call, `{ file_path, paths }` for a patch. */
  input: Record<string, unknown>
}

export type CodexDecision = 'accept' | 'acceptForSession' | 'decline'

export interface CodexDriverEvents {
  approval(approval: CodexApproval): void
  /** The approval is answered, here or in the TUI, or its turn ended. */
  resolved(requestId: string): void
  closed(why: string): void
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined)

/** What Codex's approval asks, in the terms the notch and the rules know: `Bash` for a command, `Edit` for a patch. */
export function readApproval(
  method: string,
  params: unknown,
  patches: ReadonlyMap<string, string[]> = new Map(),
): Omit<CodexApproval, 'requestId'> | null {
  const p = (params ?? {}) as Record<string, unknown>
  if (COMMAND_APPROVALS.has(method)) {
    const command = Array.isArray(p.command) ? p.command.filter(part => typeof part === 'string').join(' ') : text(p.command)
    if (!command) return null
    return {
      detail: { toolName: 'Bash', description: text(p.reason) ?? 'Run a command', inputPreview: JSON.stringify({ command }) },
      input: { command, ...(text(p.cwd) ? { cwd: p.cwd } : {}) },
    }
  }
  if (PATCH_APPROVALS.has(method)) {
    const listed = p.fileChanges && typeof p.fileChanges === 'object' ? Object.keys(p.fileChanges) : undefined
    const paths = listed ?? patches.get(String(p.itemId ?? '')) ?? []
    return {
      detail: {
        toolName: 'Edit',
        description: text(p.reason) ?? (paths.length === 1 ? 'Edit a file' : `Edit ${paths.length || 'some'} files`),
        inputPreview: JSON.stringify(paths.length === 1 ? { file_path: paths[0] } : { paths }),
      },
      input: { ...(paths[0] ? { file_path: paths[0] } : {}), paths },
    }
  }
  return null
}

/** Codex's answer for the decision, in the words of the request's version. */
export const decisionFor = (method: string, decision: CodexDecision): string =>
  LEGACY.has(method) ? { accept: 'approved', acceptForSession: 'approved_for_session', decline: 'denied' }[decision] : decision

export class CodexDriver {
  private turnId: string | null = null
  /** The model the thread runs on, as the server said when it was joined (`-m`, or Codex's own choice). */
  model: string | undefined
  /** The approvals asked, by their id as the notch has it, with Codex's own id and method. */
  private readonly asked = new Map<string, { id: RequestId; method: string }>()
  /** The files of each patch Codex is about to apply, which its newer approvals don't repeat. */
  private readonly patches = new Map<string, string[]>()

  private constructor(
    private readonly server: CodexAppServer,
    readonly threadId: string,
    private readonly events: CodexDriverEvents,
  ) {}

  /** Joins the running thread on its server. Throws when the server or the thread is not there. */
  static async attach(socket: string, threadId: string, version: string, events: CodexDriverEvents): Promise<CodexDriver> {
    let driver: CodexDriver | null = null
    const server = await CodexAppServer.connect(socket, version, {
      notification: (method, params) => driver?.notification(method, params),
      request: (id, method, params) => driver?.request(id, method, params),
      close: why => driver?.events.closed(why),
    })
    driver = new CodexDriver(server, threadId, events)
    try {
      const resumed = await server.request<{ thread?: { turns?: { id?: unknown; status?: unknown }[] }; model?: unknown }>(
        'thread/resume',
        {
          threadId,
        },
      )
      const running = resumed?.thread?.turns?.findLast(turn => turn.status === 'inProgress')
      if (typeof running?.id === 'string') driver.turnId = running.id
      if (typeof resumed?.model === 'string' && resumed.model) driver.model = resumed.model
    } catch (error) {
      server.close()
      throw error
    }
    return driver
  }

  /** A turn runs: a prompt joins it rather than waiting for its end. */
  get working(): boolean {
    return this.turnId !== null
  }

  /** The prompt, with images by their path on this machine: into the running turn, or a new one. */
  async prompt(message: string, images: string[] = []): Promise<void> {
    const input = [
      ...(message ? [{ type: 'text', text: message, text_elements: [] }] : []),
      ...images.map(path => ({ type: 'localImage', path })),
    ]
    if (!input.length) return
    if (this.turnId) {
      try {
        await this.server.request('turn/steer', { threadId: this.threadId, input, expectedTurnId: this.turnId })
        return
      } catch (error) {
        // The turn ended in between: the prompt starts the next one.
        log('codex: the prompt could not join the running turn', String(error))
      }
    }
    const started = await this.server.request<{ turn?: { id?: unknown } }>('turn/start', { threadId: this.threadId, input })
    if (typeof started?.turn?.id === 'string') this.turnId = started.turn.id
  }

  /** Stops the running turn: false when none runs. */
  async interrupt(): Promise<boolean> {
    if (!this.turnId) return false
    await this.server.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId })
    return true
  }

  async compact(): Promise<void> {
    await this.server.request('thread/compact/start', { threadId: this.threadId })
  }

  /** Answers an approval: false when it is no longer asked. */
  answer(requestId: string, decision: CodexDecision): boolean {
    const asked = this.asked.get(requestId)
    if (!asked) return false
    this.asked.delete(requestId)
    this.server.respond(asked.id, { decision: decisionFor(asked.method, decision) })
    this.events.resolved(requestId)
    return true
  }

  close() {
    this.server.close()
  }

  private ours(params: unknown): boolean {
    const p = params as { threadId?: unknown; conversationId?: unknown } | null
    return (p?.threadId ?? p?.conversationId) === this.threadId
  }

  private notification(method: string, params: unknown) {
    if (!this.ours(params)) return
    const p = params as Record<string, unknown>
    if (method === 'turn/started') {
      const id = (p.turn as { id?: unknown } | undefined)?.id
      if (typeof id === 'string') this.turnId = id
    } else if (method === 'turn/completed') {
      this.turnId = null
      // Approvals left open by the turn are not asked any more.
      for (const requestId of [...this.asked.keys()]) {
        this.asked.delete(requestId)
        this.events.resolved(requestId)
      }
      this.patches.clear()
    } else if (method === 'item/started') {
      const item = p.item as { type?: unknown; id?: unknown; changes?: unknown } | undefined
      if (item?.type === 'fileChange' && typeof item.id === 'string' && Array.isArray(item.changes)) {
        const paths = item.changes
          .map(change => (change as { path?: unknown })?.path)
          .filter((path): path is string => typeof path === 'string')
        this.patches.set(item.id, paths)
      }
    } else if (method === 'serverRequest/resolved') {
      const id = String(p.requestId ?? '')
      if (this.asked.delete(id)) this.events.resolved(id)
    }
  }

  private request(id: RequestId, method: string, params: unknown) {
    if (!this.ours(params)) return
    const approval = readApproval(method, params, this.patches)
    if (!approval) return
    const requestId = String(id)
    this.asked.set(requestId, { id, method })
    this.events.approval({ requestId, ...approval })
  }
}
