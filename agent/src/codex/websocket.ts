// A WebSocket client over a unix socket, for `codex app-server --listen unix://…`: Bun's WebSocket only dials TCP, and
// a loopback port would let any local process drive Codex, where the socket sits in a folder only this user opens.
// Text messages only, which is all JSON-RPC needs; pings get their pong, and a close frame closes (RFC 6455).

import { createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** A message larger than this ends the connection: nothing Codex sends a client comes near it. */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024
const HANDSHAKE_MS = 5000

export interface WebSocketLink {
  send(text: string): void
  close(): void
}

export interface WebSocketHandlers {
  message(text: string): void
  /** Once, however the connection ended. */
  close(why: string): void
}

const OP = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const

/** Opens the WebSocket at a unix socket path, or throws why it could not. */
export async function connectUnixWebSocket(path: string, handlers: WebSocketHandlers): Promise<WebSocketLink> {
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64')
  const accept = createHash('sha1')
    .update(key + GUID)
    .digest('base64')
  let pending: Buffer = Buffer.alloc(0)
  let upgraded = false
  let closed = false
  let fragments: Buffer[] = []
  let fragmentsSize = 0
  let opened: (link: WebSocketLink) => void = () => {}
  let failed: (error: Error) => void = () => {}
  const ready = new Promise<WebSocketLink>((resolve, reject) => {
    opened = resolve
    failed = reject
  })
  // What the socket did not take yet: Bun writes what fits and says how much.
  let unsent: Buffer = Buffer.alloc(0)
  const write = (bytes: Buffer) => {
    if (closed) return
    if (unsent.length) {
      unsent = Buffer.concat([unsent, bytes])
      return
    }
    const written = socket.write(bytes)
    if (written < bytes.length) unsent = bytes.subarray(Math.max(written, 0))
  }
  const end = (why: string) => {
    if (closed) return
    closed = true
    failed(new Error(why))
    socket.end()
    handlers.close(why)
  }
  const link: WebSocketLink = {
    send: text => write(frame(OP.text, Buffer.from(text))),
    close: () => {
      write(frame(OP.close, Buffer.alloc(0)))
      end('closed by this side')
    },
  }

  const handshake = (): boolean => {
    const head = pending.indexOf('\r\n\r\n')
    if (head < 0) {
      if (pending.length < 16_384) return false
      end('the server answered no WebSocket upgrade')
      return false
    }
    const lines = pending.subarray(0, head).toString('latin1').split('\r\n')
    pending = pending.subarray(head + 4)
    const headers = new Map(
      lines.slice(1).map(line => {
        const colon = line.indexOf(':')
        return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()] as const
      }),
    )
    if (!/^HTTP\/1\.1 101\b/.test(lines[0] ?? '') || headers.get('sec-websocket-accept') !== accept) {
      end(`the server refused the WebSocket upgrade: ${lines[0] ?? 'no answer'}`)
      return false
    }
    upgraded = true
    opened(link)
    return true
  }

  const frames = () => {
    for (;;) {
      if (pending.length < 2) return
      const first = pending[0] ?? 0
      const second = pending[1] ?? 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (pending.length < 4) return
        length = pending.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (pending.length < 10) return
        const big = pending.readBigUInt64BE(2)
        if (big > BigInt(MAX_MESSAGE_BYTES)) return end('a message from the server is too large')
        length = Number(big)
        offset = 10
      }
      const masked = (second & 0x80) !== 0
      const mask = masked ? pending.subarray(offset, offset + 4) : null
      if (masked) offset += 4
      if (pending.length < offset + length) return
      const payload = Buffer.from(pending.subarray(offset, offset + length))
      pending = pending.subarray(offset + length)
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0)
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      if (opcode === OP.ping) write(frame(OP.pong, payload))
      else if (opcode === OP.close) {
        write(frame(OP.close, Buffer.alloc(0)))
        return end('closed by the server')
      } else if (opcode === OP.text || opcode === OP.binary || opcode === OP.continuation) {
        fragmentsSize += payload.length
        if (fragmentsSize > MAX_MESSAGE_BYTES) return end('a message from the server is too large')
        fragments.push(payload)
        if (fin) {
          const message = Buffer.concat(fragments).toString('utf8')
          fragments = []
          fragmentsSize = 0
          handlers.message(message)
        }
      }
      if (closed) return
    }
  }

  const socket = await Bun.connect({
    unix: path,
    socket: {
      data(_socket, data) {
        pending = Buffer.concat([pending, Buffer.from(data)])
        if (!upgraded && !handshake()) return
        frames()
      },
      drain(socket) {
        if (!unsent.length) return
        const written = socket.write(unsent)
        unsent = unsent.subarray(Math.max(written, 0))
      },
      close() {
        end('the connection closed')
      },
      error(_socket, error) {
        end(`the connection failed: ${error.message}`)
      },
    },
  })
  socket.write(
    `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  )
  const timer = setTimeout(() => end('the server did not answer the WebSocket upgrade'), HANDSHAKE_MS)
  try {
    return await ready
  } finally {
    clearTimeout(timer)
  }
}

/** A frame from the client: always masked, as RFC 6455 requires. */
export function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  const head = length < 126 ? Buffer.alloc(2) : length < 65_536 ? Buffer.alloc(4) : Buffer.alloc(10)
  head[0] = 0x80 | opcode
  if (length < 126) head[1] = 0x80 | length
  else if (length < 65_536) {
    head[1] = 0x80 | 126
    head.writeUInt16BE(length, 2)
  } else {
    head[1] = 0x80 | 127
    head.writeBigUInt64BE(BigInt(length), 2)
  }
  const mask = Buffer.from(crypto.getRandomValues(new Uint8Array(4)))
  const body = Buffer.alloc(length)
  for (let i = 0; i < length; i++) body[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0)
  return Buffer.concat([head, mask, body])
}
