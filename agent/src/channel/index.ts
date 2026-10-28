import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { open } from '../../../shared/crypto'
import type { PromptPayload, RelayToAgent, SessionCommand } from '../../../shared/protocol'
import { loadConfig, paths } from '../config'
import { receiveDiagnoseRequest } from '../diagnose'
import { handleStartAnswer, receiveStartOrder } from '../launch'
import { log } from '../log'
import { handleLogRequest } from '../logs'
import { addSessionRules, openSessionRules, receiveRules } from '../rules'
import { handleUpdateOrder } from '../update'
import { Conversation } from './conversation'
import { ChannelServer } from './mcp'
import { RelayConnection } from './relay-connection'
import { type SessionLink, SessionLinkWatcher } from './session-link'
import { runCommand } from './terminal'

const PARENT_CHECK_MS = 5000

/**
 * MCP stdio server spawned by Claude Code, one per session: streams the conversation to the relay and
 * injects messages and permission answers coming back from the notch.
 */
export async function runChannel() {
  let conversation: Conversation | null = null
  const mcp = new ChannelServer((requestId, detail) => conversation?.addPermission(requestId, detail), {
    list: () => conversation?.work.tools() ?? [],
    call: (name, args) => conversation?.work.call(name, args) ?? Promise.resolve('This session is not in a pool.'),
  })
  await mcp.connect()
  exitWithParent()

  const config = loadConfig()
  if (!config) {
    log('channel: not enrolled, staying idle')
    return
  }
  const canChat = process.env.TONTON_CHANNEL === '1'
  log('channel started', { parent: process.ppid, canChat, cwd: process.cwd() })

  const relay: RelayConnection = new RelayConnection(config, 'channel', {
    connected: () => conversation?.announce(),
    message: message => {
      if (message.t === 'update') void handleUpdateOrder(config, message.order, relay)
      else if (message.t === 'rules') void receiveRules(config.key, message.rules)
      else if (message.t === 'start_session') receiveStartOrder(config, message.launchId, message.order, relay)
      else if (message.t === 'start_answer') void handleStartAnswer(config, message.launchId, message.answer)
      else if (message.t === 'agent_logs') void handleLogRequest(config, message.requestId, message.request, relay)
      else if (message.t === 'diagnose') void receiveDiagnoseRequest(config, message.requestId, message.request, relay, 'channel')
      // Orders for a pool machine go to the background service: a session's channel leaves them.
      else if (conversation && 'sessionId' in message && message.sessionId === conversation.link.sessionId) {
        if (message.t === 'share') conversation.shares.receive(message.shareId, message.order)
        else if (message.t === 'unshare') conversation.shares.remove(message.shareId)
        else if (message.t === 'pool_join') conversation.pools.receive(message.poolId, message.order, message.acceptance)
        else if (message.t === 'pool_left') conversation.pools.remove(message.poolId)
        else if (message.t === 'pool_stop') conversation.pools.stop(message.poolId)
        else if (message.t === 'pool_accept') conversation.pools.accept(message.poolId, message.acceptance)
        else void onRelayMessage(message)
      }
    },
    pool: update => conversation?.pools.apply(update),
  })

  const onRelayMessage = async (message: Extract<RelayToAgent, { t: 'prompt' | 'verdict' }>) => {
    if (message.t === 'verdict') {
      if (message.behavior === 'allow' && message.rule && conversation) {
        const { sessionId } = conversation.link
        addSessionRules(sessionId, await openSessionRules(config.key, message.rule, sessionId, message.requestId))
      }
      conversation?.resolvePermission(message.requestId)
      await mcp.answerPermission(message.requestId, message.behavior)
      return
    }
    let prompt: PromptPayload
    try {
      prompt = await open<PromptPayload>(config.key, message.payload)
    } catch {
      log('dropped a prompt that does not decrypt with the account key')
      return
    }
    if (prompt.command) return typeCommand(prompt.command)
    await mcp.inject(withAttachments(prompt))
  }

  const typeCommand = (command: SessionCommand) => {
    if (!conversation) return
    const result = runCommand(command, conversation.link.sessionId, conversation.link.tmux ?? null, { run: paths.run })
    log('command from the notch', { name: command.name, typed: result.typed })
    if (!result.typed && result.why) conversation.notice(`/${command.name} was not run: ${result.why}`)
  }

  const follow = (link: SessionLink) => {
    log('following session', link)
    conversation?.stop()
    conversation = new Conversation(
      link,
      config.machine,
      config.key,
      canChat,
      build => relay.post(build),
      { deliver: text => void mcp.inject(text, 'pool'), toolsChanged: () => void mcp.toolsChanged() },
      config.machineId,
    )
    conversation.start()
  }

  relay.connect()
  new SessionLinkWatcher(follow).start()
}

/** Images and files from the notch are written to the inbox and handed to Claude as paths it can Read. */
export function withAttachments(prompt: PromptPayload): string {
  if (!prompt.images.length) return prompt.text
  mkdirSync(paths.inbox, { recursive: true, mode: 0o700 })
  const files = prompt.images.map((image, index) => {
    const extension = image.mediaType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'
    const name = basename(image.name || 'image').replace(/[^\w.-]/g, '_')
    const file = join(paths.inbox, `${Date.now()}-${index}-${name}${/\.\w+$/.test(name) ? '' : `.${extension}`}`)
    writeFileSync(file, Buffer.from(image.data, 'base64'), { mode: 0o600 })
    return file
  })
  return `${prompt.text}\n\n[Attached from the notch: ${files.join(', ')}]`
}

/** stdin closing covers a normal exit of Claude Code; this covers crashes. */
function exitWithParent() {
  const parent = process.ppid
  setInterval(() => {
    try {
      process.kill(parent, 0)
    } catch (error) {
      // Only a missing process means Claude Code is gone; other errors mean the check is unsupported.
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') process.exit(0)
    }
  }, PARENT_CHECK_MS)
}
