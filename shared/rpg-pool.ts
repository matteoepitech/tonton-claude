// Pool-key-encrypted, durable contributions. No private inventory, solo work or combat score is published.
import type { PoolState } from './pool'
import type { PoolKeyring } from './pool-keys'
import type { PoolTask } from './pool-protocol'
import { RPG_CATALOG, type RPGState, rpgLevel } from './rpg'
import { grantRPGBooster } from './rpg-loot'

export interface RPGPublicHero {
  name: string
  level: number
  equipped: Record<string, string>
}
export interface RPGPoolLedger {
  version: 1
  completions: Record<string, NonNullable<PoolTask['completion']>>
  profiles: Record<string, RPGPublicHero>
  goals: Record<string, { eligible: string[]; at: string }>
}
export const RPG_TEAM_TARGETS = [3, 10, 25] as const
export const newRPGPool = (): RPGPoolLedger => ({ version: 1, completions: {}, profiles: {}, goals: {} })
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200
const date = (v: unknown): v is string => text(v) && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v))
const ref = (v: unknown) => obj(v) && text(v.account) && text(v.session)
export function parseRPGPool(value: unknown): RPGPoolLedger {
  if (
    !obj(value) ||
    value.version !== 1 ||
    !obj(value.completions) ||
    !obj(value.profiles) ||
    !obj(value.goals) ||
    Object.keys(value.completions).length > 10_000 ||
    Object.keys(value.profiles).length > 1000 ||
    Object.keys(value.goals).length > 1000 ||
    !Object.entries(value.completions).every(
      ([id, c]) => text(id) && obj(c) && date(c.at) && ref(c.assignee) && (c.reviewer === undefined || ref(c.reviewer)),
    ) ||
    !Object.entries(value.profiles).every(
      ([id, p]) =>
        text(id) &&
        obj(p) &&
        typeof p.name === 'string' &&
        p.name.length <= 200 &&
        Number.isInteger(p.level) &&
        Number(p.level) >= 1 &&
        Number(p.level) <= 100 &&
        obj(p.equipped) &&
        Object.keys(p.equipped).length <= 5 &&
        Object.entries(p.equipped).every(([slot, item]) => RPG_CATALOG.some(c => c.id === item && c.slot === slot)),
    ) ||
    !Object.entries(value.goals).every(
      ([id, g]) => text(id) && obj(g) && date(g.at) && Array.isArray(g.eligible) && g.eligible.length <= 1000 && g.eligible.every(text),
    )
  )
    throw new Error('Unsupported pool progression')
  return value as unknown as RPGPoolLedger
}
export const rpgRunStart = (state: PoolState) => state.info?.startedAt ?? state.createdAt
export const rpgGoalId = (state: PoolState, target: number) => `team-v1-${state.id}-${rpgRunStart(state)}-${target}`
/** First recorded completion wins, independent of later task edits, deletion or event pruning. */
export function syncRPGPool(ledger: RPGPoolLedger, state: PoolState, account: string, hero?: RPGState): RPGPoolLedger {
  const next = structuredClone(ledger)
  for (const item of state.tasks)
    if (item.task?.completion && !Object.hasOwn(next.completions, item.id))
      next.completions = { ...next.completions, [item.id]: item.task.completion }
  if (hero) {
    const equipped: Record<string, string> = {}
    for (const item of RPG_CATALOG) if (hero.equipped[item.slot] === item.id && hero.owned.includes(item.id)) equipped[item.slot] = item.id
    next.profiles[account] = {
      name: (state.members.find(m => m.account === account)?.profile?.name ?? account).slice(0, 200),
      level: rpgLevel(hero.xp),
      equipped,
    }
  }
  const completions = Object.entries(next.completions)
    .filter(([, c]) => Date.parse(c.at) >= Date.parse(rpgRunStart(state)))
    .sort(([a, x], [b, y]) => Date.parse(x.at) - Date.parse(y.at) || (a < b ? -1 : a > b ? 1 : 0))
  for (const target of RPG_TEAM_TARGETS) {
    const id = rpgGoalId(state, target)
    if (completions.length < target || Object.hasOwn(next.goals, id)) continue
    const first = completions.slice(0, target).map(([, c]) => c)
    next.goals[id] = {
      at: first[first.length - 1].at,
      eligible: [...new Set(first.flatMap(c => [c.assignee.account, ...(c.reviewer ? [c.reviewer.account] : [])]))].sort(),
    }
  }
  return parseRPGPool(next)
}
export function claimRPGTeam(hero: RPGState, ledger: RPGPoolLedger, account: string): RPGState {
  return Object.entries(ledger.goals)
    .filter(([, goal]) => goal.eligible.includes(account))
    .reduce((h, [id]) => grantRPGBooster(h, id), hero)
}
export function rpgStandings(ledger: RPGPoolLedger, state: PoolState, period: 'today' | 'run' | 'all', now = new Date()) {
  const start = period === 'all' ? '' : period === 'run' ? rpgRunStart(state) : `${now.toISOString().slice(0, 10)}T00:00:00.000Z`
  const rows = new Map<
    string,
    { account: string; name: string; level: number; equipped: Record<string, string>; xp: number; departed: boolean }
  >()
  const row = (account: string) => {
    let value = rows.get(account)
    if (!value) {
      const member = state.members.find(m => m.account === account)
      const profile = ledger.profiles[account]
      value = {
        account,
        name: member?.profile?.name ?? profile?.name ?? account,
        level: profile?.level ?? 1,
        equipped: profile?.equipped ?? {},
        xp: 0,
        departed: !member,
      }
      rows.set(account, value)
    }
    return value
  }
  for (const member of state.members) row(member.account)
  for (const account of Object.keys(ledger.profiles)) row(account)
  for (const c of Object.values(ledger.completions)) {
    row(c.assignee.account)
    if (c.reviewer) row(c.reviewer.account)
    if (Date.parse(c.at) < Date.parse(start || '1970-01-01')) continue
    row(c.assignee.account).xp += 50
    if (c.reviewer) row(c.reviewer.account).xp += 20
  }
  return [...rows.values()].sort((a, b) => b.xp - a.xp || (a.account < b.account ? -1 : a.account > b.account ? 1 : 0))
}
export class RPGPoolClient {
  constructor(
    private url: string,
    private token: string,
    private keys: PoolKeyring,
  ) {}
  private async request(method: string, body?: unknown) {
    const response = await fetch(this.url, {
      method,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok && response.status !== 409) throw new Error(`Pool progression unavailable (${response.status})`)
    return response
  }
  async read() {
    const value = (await (await this.request('GET')).json()) as { rev: number; blob: string | null }
    if (!Number.isSafeInteger(value.rev) || value.rev < 0 || (value.rev === 0) !== (value.blob === null))
      throw new Error('Invalid pool revision')
    return { rev: value.rev, ledger: value.blob === null ? newRPGPool() : parseRPGPool(await this.keys.open(value.blob)) }
  }
  async change(apply: (ledger: RPGPoolLedger) => RPGPoolLedger) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const { rev, ledger } = await this.read()
      const next = parseRPGPool(apply(ledger))
      if (JSON.stringify(next) === JSON.stringify(ledger)) return ledger
      if ((await this.request('PUT', { rev, blob: await this.keys.seal(next) })).status !== 409) return next
    }
    throw new Error('Pool progression busy; retry')
  }
}
