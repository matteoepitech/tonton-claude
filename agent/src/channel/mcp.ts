import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import type { PermissionDetail } from '../../../shared/protocol'
import { VERSION } from '../config'

const INSTRUCTIONS = [
  'The user can also drive this session remotely from Tonton Claude, a macOS notch app.',
  'Their messages arrive as <channel source="tonton" ...>. Treat each one exactly like a message typed in the terminal by the user.',
  'Answer normally: the user sees the whole conversation in the notch, so there is no reply tool to call.',
  'When a message mentions an attached image file path, open it with the Read tool to see it.',
].join(' ')

const PermissionRequest = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({ request_id: z.string(), tool_name: z.string(), description: z.string(), input_preview: z.string() }),
})

/** The MCP side of the channel: Claude Code spawns it and talks to it over stdio. */
export class ChannelServer {
  private readonly server = new Server(
    { name: 'tonton', version: VERSION },
    { capabilities: { experimental: { 'claude/channel': {}, 'claude/channel/permission': {} } }, instructions: INSTRUCTIONS },
  )

  constructor(onPermissionRequest: (requestId: string, detail: PermissionDetail) => void) {
    this.server.setNotificationHandler(PermissionRequest, async ({ params }) => {
      onPermissionRequest(params.request_id, {
        toolName: params.tool_name,
        description: params.description,
        inputPreview: params.input_preview,
      })
    })
  }

  /** Resolves once connected. The process exits when Claude Code closes the pipe. */
  async connect() {
    this.server.onclose = () => process.exit(0)
    await this.server.connect(new StdioServerTransport())
  }

  /** Delivers a message to Claude as if the user had typed it. */
  async inject(content: string) {
    await this.server.notification({ method: 'notifications/claude/channel', params: { content, meta: { sender: 'notch' } } })
  }

  async answerPermission(requestId: string, behavior: 'allow' | 'deny') {
    await this.server.notification({ method: 'notifications/claude/channel/permission', params: { request_id: requestId, behavior } })
  }
}
