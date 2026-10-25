import type { Server } from 'bun'
import type { SocketData } from './hub'

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

export const fail = (status: number, message: string) => json({ error: message }, status)

export function bearerToken(req: Request): string {
  const header = req.headers.get('authorization') ?? ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

export function clientIp(req: Request, server: Server<SocketData>, trustProxy: boolean): string {
  const forwarded = trustProxy ? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() : undefined
  return forwarded || server.requestIP(req)?.address || 'unknown'
}

export async function readJson<T>(req: Request, maxBytes: number): Promise<T | null> {
  const length = Number(req.headers.get('content-length') ?? 0)
  if (length > maxBytes) return null
  const text = await req.text().catch(() => '')
  if (text.length > maxBytes) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}
