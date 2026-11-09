// What the notch, the website and the iPhone send a Codex session that runs through `tonton codex`: its messages with
// images, `/compact` and interrupt, and the answers to its approvals, through a CodexDriver on the session's app-server.
// The auto-approve rules answer what they match first, as Claude Code's PermissionRequest hook does, then the pool
// rules its owner accepted and a pool machine's mode. What its pools and clusters send it goes in the same way, and a
// pool stops its turn through it. A Codex started plainly (`codex`) has no server Tonton reaches: the notch only shows it.

import { mkdirSync, writeFileSync } from 'node:fs'
import { open } from '../../../shared/crypto'
import type { PermissionDetail, PromptPayload, RelayToAgent, SessionCommand } from '../../../shared/protocol'
import { saveToInbox } from '../channel/inbox'
import { claimCommand, whyInvalid } from '../channel/terminal'
import { paths, VERSION } from '../config'
import { log } from '../log'
import { addSessionRules, codexModeAllows, matchingRule, openSessionRules, poolMode, poolRules, readRules, sessionRules } from '../rules'
import { type CodexApproval, CodexDriver } from './driver'
import { codexModelFile, codexRun } from './wrapper'

/** What the notch can ask a Codex session to run. */
export const CODEX_COMMANDS: SessionCommand['name'][] = ['compact', 'interrupt']

/** The channel's conversation, as far as the notch's messages need it. */
export interface CodexNotchSession {
  readonly link: { sessionId: string }
  addPermission(requestId: string, detail: PermissionDetail): void
  /** Answered from the notch. */
  resolvePermission(requestId: string): void
  /** Answered elsewhere (in the TUI), or no longer asked. */
  closePermission(requestId: string): void
  notice(text: string): void
}

/** A prompt as Codex takes it: the text, with files other than images named in it, and the images by path. */
export function codexPrompt(prompt: PromptPayload, inbox = paths.inbox): { text: string; images: string[] } {
  const saved = saveToInbox(prompt.images, inbox)
  const images = saved.filter(file => file.image).map(file => file.path)
  const others = saved.filter(file => !file.image).map(file => file.path)
  return { text: others.length ? `${prompt.text}\n\n[Attached from the notch: ${others.join(', ')}]` : prompt.text, images }
}

export class CodexNotch {
  private driver: CodexDriver | null = null
  private attaching: Promise<void> = Promise.resolve()
  /** Posts go in one after the other: the first may start a turn, which the next ones then join. */
  private injecting: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly socket: string,
    private readonly key: string,
    private readonly session: () => CodexNotchSession | null,
  ) {}

  /** Joins the thread the channel follows now: the first one, or the next after `/new`. */
  follow(threadId: string) {
    this.close()
    this.attaching = CodexDriver.attach(this.socket, threadId, VERSION, {
      approval: approval => this.approval(threadId, approval),
      resolved: requestId => this.session()?.closePermission(requestId),
      closed: why => {
        log('codex: the app-server connection closed', { why })
        if (this.driver?.threadId === threadId) this.driver = null
      },
    }).then(
      driver => {
        this.driver = driver
        if (driver.model) this.sayModel(threadId, { model: driver.model })
      },
      error => {
        log('codex: could not join the thread on its app-server', String(error))
        this.sayModel(threadId, { problem: 'Tonton could not join the Codex thread on its app-server' })
      },
    )
  }

  /**
   * Puts text from a pool or a cluster in front of Codex: into the running turn (turn/steer), else a new turn.
   * False when Codex cannot be reached (a plain codex, or its server gone).
   */
  async inject(text: string): Promise<boolean> {
    const sent = this.injecting.then(async () => {
      await this.attaching
      const driver = this.driver
      if (!driver) return false
      try {
        await driver.prompt(text)
        return true
      } catch (error) {
        log('codex: a post did not reach Codex', messageOf(error))
        return false
      }
    })
    this.injecting = sent
    return sent
  }

  /** Stops the running turn, for a pool that stops the session's work: null when stopped or none ran, otherwise why not. */
  async interrupt(): Promise<string | null> {
    await this.attaching
    const driver = this.driver
    if (!driver) return 'Codex cannot be reached on its app-server.'
    try {
      await driver.interrupt()
      return null
    } catch (error) {
      return `Codex did not take it: ${messageOf(error)}`
    }
  }

  async receive(message: Extract<RelayToAgent, { t: 'prompt' | 'verdict' }>) {
    await this.attaching
    const session = this.session()
    const driver = this.driver
    if (!session || !driver) return log('channel: dropped a message, Codex cannot be reached', { kind: message.t })
    if (message.t === 'verdict') {
      const { sessionId } = session.link
      if (message.behavior === 'allow' && message.rule)
        addSessionRules(sessionId, await openSessionRules(this.key, message.rule, sessionId, message.requestId))
      session.resolvePermission(message.requestId)
      driver.answer(message.requestId, message.behavior === 'allow' ? 'accept' : 'decline')
      return
    }
    let prompt: PromptPayload
    try {
      prompt = await open<PromptPayload>(this.key, message.payload)
    } catch {
      return log('dropped a prompt that does not decrypt with the account key')
    }
    if (prompt.command) return this.command(prompt.command, session, driver)
    const { text, images } = codexPrompt(prompt)
    await driver.prompt(text, images).catch(error => session.notice(`The message did not reach Codex: ${messageOf(error)}`))
  }

  /** Codex is in a turn, as its server says: a post joins it rather than waking the session. */
  get working(): boolean {
    return this.driver?.working ?? false
  }

  close() {
    this.driver?.close()
    this.driver = null
  }

  /**
   * An auto-approve rule, one allowed for this session, or one its owner accepted from a pool answers at once, and so
   * does a pool machine's mode; otherwise the notch asks.
   */
  private approval(threadId: string, approval: CodexApproval) {
    const tool = approval.detail.toolName
    const rules = [...(readRules()?.rules ?? []), ...sessionRules(threadId), ...poolRules(threadId)]
    const rule = matchingRule(rules, tool, approval.input)
    const listed = approval.input.paths
    const files = Array.isArray(listed) ? listed.filter((file): file is string => typeof file === 'string') : []
    if (rule || codexModeAllows(poolMode(threadId), tool, files)) {
      log(rule ? 'approved by an auto-approve rule' : 'approved by the pool machine’s mode', { tool })
      this.driver?.answer(approval.requestId, 'accept')
      return
    }
    this.session()?.addPermission(approval.requestId, approval.detail)
  }

  private sayModel(threadId: string, said: { model?: string; problem?: string }) {
    try {
      mkdirSync(codexRun(), { recursive: true, mode: 0o700 })
      writeFileSync(codexModelFile(threadId), JSON.stringify(said), { mode: 0o600 })
    } catch (error) {
      log('codex: could not say which model the thread runs on', String(error))
    }
  }

  private async command(command: SessionCommand, session: CodexNotchSession, driver: CodexDriver) {
    const invalid = whyInvalid(command, session.link.sessionId)
    if (invalid) return session.notice(invalid)
    if (!CODEX_COMMANDS.includes(command.name)) return session.notice(`/${command.name} was not run: Codex has no such command.`)
    const claimed = claimCommand(command, paths.run)
    if (claimed !== true) return claimed.why ? session.notice(claimed.why) : undefined
    log('command from the notch', { name: command.name, tool: 'codex' })
    try {
      if (command.name === 'compact') await driver.compact()
      else if (!(await driver.interrupt())) session.notice('Nothing to interrupt: Codex is not working.')
    } catch (error) {
      session.notice(`/${command.name} was not run: ${messageOf(error)}`)
    }
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
