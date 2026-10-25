import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { PromptPayload, RelayToAgent } from '../../../shared/protocol'
import { loadConfig, paths } from '../config'
import { open } from '../crypto'
import { log } from '../log'
import { handleUpdateOrder } from '../update'
import { Conversation } from './conversation'
import { ChannelServer } from './mcp'
import { RelayConnection } from './relay-connection'
import { type SessionLink, SessionLinkWatcher } from './session-link'

const PARENT_CHECK_MS = 5000

/**
 * MCP stdio server spawned by Claude Code, one per session: streams the conversation to the relay and
 * injects messages and permission answers coming back from the notch.
 */
export async function runChannel() {
  let conversation: Conversation | null = null
  const mcp = new ChannelServer((requestId, detail) => conversation?.addPermission(requestId, detail))
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
      else if (conversation && message.sessionId === conversation.link.sessionId) void onRelayMessage(message)
    },
  })

  const onRelayMessage = async (message: Exclude<RelayToAgent, { t: 'update' }>) => {
    if (message.t === 'verdict') {
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
    await mcp.inject(withAttachments(prompt))
  }

  const follow = (link: SessionLink) => {
    log('following session', link)
    conversation?.stop()
    conversation = new Conversation(link, config.machine, config.key, canChat, build => relay.post(build))
    conversation.start()
  }

  relay.connect()
  new SessionLinkWatcher(follow).start()
}

/** Images from the notch are written to the inbox and handed to Claude as paths it can Read. */
function withAttachments(prompt: PromptPayload): string {
  if (!prompt.images.length) return prompt.text
  mkdirSync(paths.inbox, { recursive: true, mode: 0o700 })
  const files = prompt.images.map((image, index) => {
    const extension = image.mediaType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'
    const name = basename(image.name || 'image').replace(/[^\w.-]/g, '_')
    const file = join(paths.inbox, `${Date.now()}-${index}-${name}${/\.\w+$/.test(name) ? '' : `.${extension}`}`)
    writeFileSync(file, Buffer.from(image.data, 'base64'), { mode: 0o600 })
    return file
  })
  return `${prompt.text}\n\n[Image(s) attached from the notch: ${files.join(', ')}]`
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
