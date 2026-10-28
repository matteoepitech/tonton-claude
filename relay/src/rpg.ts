// Account-scoped encrypted storage. The relay never parses or logs character data.
import type { RPGDocument } from '../../shared/rpg'
import type { RelayContext } from './context'
import { fail, json, readJson } from './http'
import { MAX_RPG_BYTES } from './limits'
import { isRPGWrite } from './validate'

export async function rpgRoute(ctx: RelayContext, req: Request, account: string): Promise<Response> {
  const db = ctx.registry.db
  const read = (): RPGDocument =>
    (db.query('SELECT rev, blob FROM rpg_profiles WHERE account_id = ?').get(account) as RPGDocument | null) ?? { rev: 0, blob: null }
  if (req.method === 'GET') return json(read())
  if (req.method !== 'PUT') return fail(405, 'Method not allowed.')
  const body = await readJson<unknown>(req, MAX_RPG_BYTES + 1024)
  if (!isRPGWrite(body)) return fail(400, 'Invalid hero document.')
  const result = db.transaction(() => {
    const current = read()
    if (current.rev !== body.rev) return false
    db.query(`INSERT INTO rpg_profiles (account_id, rev, blob) VALUES (?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET rev = excluded.rev, blob = excluded.blob`).run(account, body.rev + 1, body.blob)
    return true
  })()
  return result ? json({ rev: body.rev + 1 }) : fail(409, 'Hero changed; read and retry.')
}
