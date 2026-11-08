import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { PermissionDetail } from '../../../shared/protocol'
import { VERSION } from '../config'
import { CLUSTER_INSTRUCTIONS, isClusterTool } from './cluster-work'
import { ALL_POOL_TOOLS, POOL_INSTRUCTIONS, type PoolToolSpec } from './pool-work'

const CHANNEL_INSTRUCTIONS = [
  'The user can also drive this session remotely from Tonton Claude, a macOS notch app.',
  'Their messages arrive as <channel source="tonton" ...>. Treat each one exactly like a message typed in the terminal by the user.',
  'Answer normally: the user sees the whole conversation in the notch, so there is no reply tool to call.',
  'When a message mentions an attached image file path, open it with the Read tool to see it.',
]
const INSTRUCTIONS = [...CHANNEL_INSTRUCTIONS, POOL_INSTRUCTIONS, CLUSTER_INSTRUCTIONS].join(' ')
/** Codex has no channel: nothing from the notch arrives in the conversation (yet), only the tools are served. */
const TOOL_INSTRUCTIONS = [POOL_INSTRUCTIONS, CLUSTER_INSTRUCTIONS].join(' ')

/** The pool and cluster tools of the session, while it is in a pool or a cluster (see pool-work.ts, cluster-work.ts). */
export interface ChannelTools {
  list(): PoolToolSpec[]
  call(name: string, args: Record<string, unknown>): Promise<string>
}

/** A tool's arguments as the JSON Schema MCP takes. */
export function inputSchema(spec: PoolToolSpec) {
  const properties = Object.fromEntries(
    Object.entries(spec.params).map(([name, param]) => [
      name,
      param.type === 'array'
        ? { type: 'array', items: { type: 'string' }, description: param.description }
        : { type: param.type, description: param.description },
    ]),
  )
  const required = Object.entries(spec.params)
    .filter(([, param]) => param.required)
    .map(([name]) => name)
  return { type: 'object' as const, properties, ...(required.length ? { required } : {}) }
}

const PermissionRequest = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({ request_id: z.string(), tool_name: z.string(), description: z.string(), input_preview: z.string() }),
})

/**
 * The MCP side of the channel: Claude Code or Codex spawns it and talks to it over stdio. Only Claude Code's has the
 * channel capabilities, which carry messages and permission prompts both ways; Codex's serves the tools.
 */
export class ChannelServer {
  private readonly server: Server

  constructor(
    onPermissionRequest: (requestId: string, detail: PermissionDetail) => void,
    tools: ChannelTools = { list: () => [], call: async () => 'This session is not in a pool.' },
    { channel = true }: { channel?: boolean } = {},
  ) {
    this.server = new Server(
      { name: 'tonton', version: VERSION },
      channel
        ? {
            capabilities: { experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }, tools: { listChanged: true } },
            instructions: INSTRUCTIONS,
          }
        : { capabilities: { tools: { listChanged: true } }, instructions: TOOL_INSTRUCTIONS },
    )
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.list().map(spec => ({ name: spec.name, description: spec.description, inputSchema: inputSchema(spec) })),
    }))
    this.server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const listed = tools.list()
      if (!listed.length) {
        const text = isClusterTool(params.name) ? 'This session is not in a cluster.' : 'This session is not in a pool.'
        return { content: [{ type: 'text', text }], isError: true }
      }
      // An orchestrator's tool called by another session gets its answer from the pool tools: who may call it.
      if (!listed.some(spec => spec.name === params.name) && !ALL_POOL_TOOLS.some(spec => spec.name === params.name)) {
        return { content: [{ type: 'text', text: `No such tool: ${params.name}.` }], isError: true }
      }
      const text = await tools.call(params.name, (params.arguments ?? {}) as Record<string, unknown>)
      return { content: [{ type: 'text', text }] }
    })
    this.server.setNotificationHandler(PermissionRequest, async ({ params }) => {
      onPermissionRequest(params.request_id, {
        toolName: params.tool_name,
        description: params.description,
        inputPreview: params.input_preview,
      })
    })
  }

  /** Resolves once connected. The process exits when Claude Code or Codex closes the pipe, after `closed` for Codex. */
  async connect(closed: () => void = () => process.exit(0)) {
    this.server.onclose = closed
    await this.server.connect(new StdioServerTransport())
  }

  /**
   * Delivers a message to Claude as if the user had typed it, or, from `pool` or `cluster`, as a message from the
   * session's pool or one of its clusters: Claude Code shows the sender, so that it is never taken for the user.
   */
  async inject(content: string, sender: 'notch' | 'pool' | 'cluster' = 'notch') {
    await this.server.notification({ method: 'notifications/claude/channel', params: { content, meta: { sender } } })
  }

  /** The pool or cluster tools appeared or went away. */
  async toolsChanged() {
    await this.server.sendToolListChanged().catch(() => {})
  }

  async answerPermission(requestId: string, behavior: 'allow' | 'deny') {
    await this.server.notification({ method: 'notifications/claude/channel/permission', params: { request_id: requestId, behavior } })
  }
}
