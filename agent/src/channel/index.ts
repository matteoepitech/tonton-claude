import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { open } from '../../../shared/crypto'
import type { PromptPayload, RelayToAgent, SessionCommand } from '../../../shared/protocol'
import { CodexNotch } from '../codex/notch'
import { readServerRecord } from '../codex/wrapper'
import { loadConfig, paths } from '../config'
import { receiveDiagnoseRequest } from '../diagnose'
import { postHook } from '../hook'
import { handleStartAnswer, receiveStartOrder } from '../launch'
import { log } from '../log'
import { handleLogRequest } from '../logs'
import { AgentRPG } from '../rpg'
import { addSessionRules, openSessionRules, receiveRules } from '../rules'
import { handleUpdateOrder } from '../update'
import { isClusterTool } from './cluster-work'
import { Conversation } from './conversation'
import { saveToInbox } from './inbox'
import { ChannelServer } from './mcp'
import { RelayConnection } from './relay-connection'
import { type SessionLink, SessionLinkWatcher } from './session-link'
import { runCommand } from './terminal'

const PARENT_CHECK_MS = 5000

/**
 * MCP stdio server spawned by Claude Code, one per session: streams the conversation to the relay and
 * injects messages and permission answers coming back from the notch. Codex spawns it as `channel codex`: the same, but
 * Codex takes no message from an MCP server, so nothing from the notch goes in, and it has no SessionEnd hook, so the
 * channel says the session ended when Codex stops it.
 */
export async function runChannel(tool: 'claude' | 'codex' = 'claude') {
  const codex = tool === 'codex'
  let conversation: Conversation | null = null
  // The pool tools and the cluster tools, side by side: a session can be in a pool and a cluster at once.
  const mcp = new ChannelServer(
    (requestId, detail) => conversation?.addPermission(requestId, detail),
    {
      list: () => [...(conversation?.work.tools() ?? []), ...(conversation?.cluster.tools() ?? [])],
      call: (name, args) =>
        isClusterTool(name)
          ? (conversation?.cluster.call(name, args) ?? Promise.resolve('This session is not in a cluster.'))
          : (conversation?.work.call(name, args) ?? Promise.resolve('This session is not in a pool.')),
    },
    { channel: !codex },
  )
  const config = loadConfig()
  // Read now: once codex is gone, the channel's parent is another process.
  const linkFile = join(paths.run, `${process.ppid}.json`)
  let ending = false
  // Codex stops its MCP servers when it exits: the session ends with it, as Claude Code's SessionEnd hook says.
  const end = async () => {
    if (ending) return
    ending = true
    const sessionId = conversation?.link.sessionId
    if (config && sessionId) {
      await postHook(config, { hook_event_name: 'SessionEnd', session_id: sessionId }).catch(() => {})
      unlink(linkFile, sessionId)
    }
    process.exit(0)
  }
  if (codex) process.on('SIGTERM', () => void end())
  await mcp.connect(codex ? () => void end() : undefined)
  exitWithParent(codex ? () => void end() : undefined)

  if (!config) {
    log('channel: not enrolled, staying idle')
    return
  }
  // A Codex run by `tonton codex` is this process's parent, an app-server the notch reaches through `tonton codex`'s
  // socket; a plain `codex` has none, and the notch only shows its session.
  const server = codex ? readServerRecord(process.ppid) : null
  const notch = server ? new CodexNotch(server.socket, config.key, () => conversation) : null
  const canChat = codex ? notch !== null : process.env.TONTON_CHANNEL === '1'
  const rpg = new AgentRPG(config)
  log('channel started', { parent: process.ppid, canChat, cwd: process.cwd(), ...(codex ? { tool } : {}) })

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
        else if (message.t === 'cluster_join') conversation.clusters.receive(message.clusterId, message.order)
        else if (message.t === 'cluster_left') conversation.clusters.remove(message.clusterId)
        else if (message.t === 'prompt' || message.t === 'verdict') void onRelayMessage(message)
      }
    },
    pool: update => conversation?.pools.apply(update),
    cluster: update => conversation?.clusters.apply(update),
  })

  const onRelayMessage = async (message: Extract<RelayToAgent, { t: 'prompt' | 'verdict' }>) => {
    // A plain codex: its hello says it cannot chat, so the notch sends nothing, and anything that comes is dropped.
    if (codex) return notch ? notch.receive(message) : log('channel: dropped a message for a Codex session', { kind: message.t })
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

  // What its pools and clusters send a Codex session has no way in yet: it waits for the Codex delivery of #371 and #372.
  const pool = codex
    ? { deliver: () => {}, toolsChanged: () => void mcp.toolsChanged() }
    : { deliver: (text: string) => void mcp.inject(text, 'pool'), toolsChanged: () => void mcp.toolsChanged() }
  const cluster = codex
    ? { live: () => {}, toolsChanged: () => void mcp.toolsChanged() }
    : { live: (text: string) => void mcp.inject(text, 'cluster'), toolsChanged: () => void mcp.toolsChanged() }

  const follow = (link: SessionLink) => {
    log('following session', link)
    const previous = conversation?.link
    conversation?.stop()
    // A new thread in the same codex (`/new`): the one before ended, and no hook says so. Only one a hook linked: a guess
    // from the folder may have been another codex's session.
    if (codex && previous?.event && previous.sessionId !== link.sessionId)
      void postHook(config, { hook_event_name: 'SessionEnd', session_id: previous.sessionId }).catch(() => {})
    conversation = new Conversation(
      link,
      config.machine,
      config.key,
      canChat,
      build => relay.post(build),
      pool,
      config.machineId,
      rpg,
      cluster,
      config,
    )
    conversation.start()
    notch?.follow(link.sessionId)
  }

  relay.connect()
  new SessionLinkWatcher(follow, tool).start()
}

/** The link goes with its session, as Claude Code's SessionEnd hook takes it (agent/src/hook.ts). */
function unlink(file: string, sessionId: string) {
  try {
    if ((JSON.parse(readFileSync(file, 'utf8')) as { sessionId?: unknown }).sessionId === sessionId) rmSync(file, { force: true })
  } catch {
    // No link, or one being written.
  }
}

/** Images and files from the notch are written to the inbox and handed to Claude as paths it can Read. */
export function withAttachments(prompt: PromptPayload): string {
  if (!prompt.images.length) return prompt.text
  const files = saveToInbox(prompt.images).map(file => file.path)
  return `${prompt.text}\n\n[Attached from the notch: ${files.join(', ')}]`
}

/** stdin closing covers a normal exit of Claude Code; this covers crashes. */
function exitWithParent(gone: () => void = () => process.exit(0)) {
  const parent = process.ppid
  setInterval(() => {
    try {
      process.kill(parent, 0)
    } catch (error) {
      // Only a missing process means Claude Code or Codex is gone; other errors mean the check is unsupported.
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') gone()
    }
  }, PARENT_CHECK_MS)
}
