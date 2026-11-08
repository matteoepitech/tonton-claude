// What the notch, the website and the iPhone send a Codex session that runs through `tonton codex`: its messages with
// images, `/compact` and interrupt, and the answers to its approvals, through a CodexDriver on the session's app-server.
// The auto-approve rules answer what they match first, as Claude Code's PermissionRequest hook does. A Codex started
// plainly (`codex`) has no server Tonton reaches: the notch only shows it.

import { open } from '../../../shared/crypto'
import type { PermissionDetail, PromptPayload, RelayToAgent, SessionCommand } from '../../../shared/protocol'
import { saveToInbox } from '../channel/inbox'
import { claimCommand, whyInvalid } from '../channel/terminal'
import { paths, VERSION } from '../config'
import { log } from '../log'
import { addSessionRules, matchingRule, openSessionRules, readRules, sessionRules } from '../rules'
import { type CodexApproval, CodexDriver } from './driver'

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
      },
      error => log('codex: could not join the thread on its app-server', String(error)),
    )
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

  close() {
    this.driver?.close()
    this.driver = null
  }

  /** An auto-approve rule, or one allowed for this session, answers at once; otherwise the notch asks. */
  private approval(threadId: string, approval: CodexApproval) {
    const rules = [...(readRules()?.rules ?? []), ...sessionRules(threadId)]
    if (matchingRule(rules, approval.detail.toolName, approval.input)) {
      log('approved by an auto-approve rule', { tool: approval.detail.toolName })
      this.driver?.answer(approval.requestId, 'accept')
      return
    }
    this.session()?.addPermission(approval.requestId, approval.detail)
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
