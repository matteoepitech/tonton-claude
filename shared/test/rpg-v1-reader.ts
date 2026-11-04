// A frozen copy of the version 1 reader (shared/rpg.ts before rules version 2), to prove released clients still open
// a version 2 hero. Never update it: it stands for what is already installed.
const LIMIT = 10_000
const SLOTS = ['skin', 'hat', 'accessory', 'aura', 'trail']
const REWARDS: Record<string, { xp: number; sparks: number }> = {
  task: { xp: 10, sparks: 1 },
  poolTask: { xp: 50, sparks: 5 },
  review: { xp: 20, sparks: 2 },
  encounter: { xp: 15, sparks: 2 },
  boss: { xp: 75, sparks: 10 },
}
const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= LIMIT && v.every(s => typeof s === 'string' && s.length <= 200)

function isV1Reward(v: Record<string, unknown>): v is Record<string, unknown> & { id: string; kind: string; day: string } {
  if (!object(v)) return false
  return (
    typeof v.id === 'string' &&
    /^[a-f0-9]{64}$/.test(v.id) &&
    typeof v.kind === 'string' &&
    Object.hasOwn(REWARDS, v.kind) &&
    typeof v.day === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(v.day) &&
    Number.isFinite(Date.parse(`${v.day}T00:00:00Z`))
  )
}
export function parseV1State(v: unknown): unknown {
  if (
    !object(v) ||
    v.version !== 1 ||
    !integer(v.xp) ||
    !integer(v.sparks) ||
    !strings(v.owned) ||
    !strings(v.boosters) ||
    !object(v.equipped) ||
    !object(v.upgrades) ||
    !object(v.openings) ||
    Object.keys(v.openings).length > LIMIT ||
    !Object.entries(v.openings).every(
      ([id, opening]) =>
        id.length <= 200 &&
        object(opening) &&
        typeof opening.item === 'string' &&
        opening.item.length <= 200 &&
        integer(opening.duplicateSparks) &&
        opening.duplicateSparks <= 50 &&
        (opening.tableVersion === undefined || opening.tableVersion === 1),
    ) ||
    !Array.isArray(v.receipts) ||
    v.receipts.length > LIMIT ||
    !v.receipts.every(
      r =>
        object(r) &&
        integer(r.xp) &&
        integer(r.sparks) &&
        isV1Reward(r) &&
        r.xp <= REWARDS[r.kind].xp &&
        r.sparks <= REWARDS[r.kind].sparks,
    ) ||
    !Object.entries(v.equipped).every(([slot, id]) => SLOTS.includes(slot) && typeof id === 'string' && id.length <= 200) ||
    !Object.values(v.upgrades).every(n => integer(n) && n <= 10)
  )
    throw new Error('Unsupported or invalid hero data')
  return v
}
