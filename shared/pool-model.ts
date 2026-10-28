// Which model a pool task runs on (#283): the least costly one that can reliably do it. A machine sorts its models into
// three tiers its owner can configure: light for routine work, balanced for ordinary features, strong for the demanding
// ones. Each task is assessed from what it says (goal, criteria, size, hours, dependencies, paths), not from the tool
// that runs it, and climbs a tier only on evidence that a session could not do it, within the owner's limit. Pure code,
// cheap enough to run for every task: no model is asked to classify. Runs in browsers, like the rest of the client core.

import type { ModelTier, PoolModelPolicy, PoolTask, PoolTaskRoute } from './pool-protocol'

export const MODEL_TIERS: readonly ModelTier[] = ['light', 'balanced', 'strong']

/**
 * What each tier stands for when the owner says nothing: Claude Code's aliases, each the latest model of its family. For
 * OpenCode they are families its catalog resolves; a provider with none of them leaves the session on its own model.
 */
export const DEFAULT_TIER_MODELS: Readonly<Record<ModelTier, string>> = { light: 'haiku', balanced: 'sonnet', strong: 'opus' }

/** Tiers a task may climb after its sessions failed it, unless the owner says otherwise. */
export const DEFAULT_ESCALATIONS = 1
const MAX_ESCALATIONS = 2

/** A Claude Code alias or model id (`sonnet`, `claude-sonnet-4-5`), or an OpenCode `provider/model`. */
const MODEL_ID = /^[\w.:@[\]-]+(\/[\w.:@[\]-]+)?$/

export function isModelTier(value: unknown): value is ModelTier {
  return typeof value === 'string' && (MODEL_TIERS as readonly string[]).includes(value)
}

/** A model name the agent can pass on: anything else could carry a shell or a flag into the session's command line. */
export function isModelId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && MODEL_ID.test(value)
}

// MARK: Decoding what other members sealed

type Fields = Record<string, unknown>
const fields = (value: unknown): Fields | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : null
const defined = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
const count = (value: unknown, max: number): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : undefined
const text = (value: unknown, max: number): string | undefined => (typeof value === 'string' ? value.slice(0, max) : undefined)

/** A machine's policy as its owner sealed it: what is malformed is dropped, so the tier it stands for falls back. */
export function decodeModelPolicy(value: unknown): PoolModelPolicy | undefined {
  const f = fields(value)
  if (!f) return undefined
  const allowed = Array.isArray(f.allowed) ? MODEL_TIERS.filter(tier => (f.allowed as unknown[]).includes(tier)) : undefined
  const named = fields(f.tiers)
  const tiers = named
    ? defined({ light: modelId(named.light), balanced: modelId(named.balanced), strong: modelId(named.strong) })
    : undefined
  const policy = defined({
    lock: isModelTier(f.lock) ? f.lock : undefined,
    allowed: allowed?.length ? allowed : undefined,
    tiers: tiers && Object.keys(tiers).length ? tiers : undefined,
    escalations: count(f.escalations, MAX_ESCALATIONS),
  })
  return Object.keys(policy).length ? policy : undefined
}

/** A task's route, as its machine wrote it. */
export function decodeTaskRoute(value: unknown): PoolTaskRoute | undefined {
  const f = fields(value)
  if (!f) return undefined
  const route = defined({
    tier: isModelTier(f.tier) ? f.tier : undefined,
    model: modelId(f.model),
    reason: text(f.reason, 500),
    escalated: count(f.escalated, MAX_ESCALATIONS),
    confirmed: modelId(f.confirmed),
    problem: text(f.problem, 500),
    at: text(f.at, 40),
  })
  return Object.keys(route).length ? route : undefined
}

const modelId = (value: unknown): string | undefined => (isModelId(value) ? value : undefined)

// MARK: Assessing a task

/** Work that needs a strong model whatever its size: design across parts, hard debugging, code where mistakes cost. */
const DEMANDING =
  /\b(architect\w*|re-?design\w*|migrat\w*|protocol\w*|crypto\w*|encrypt\w*|concurren\w*|race condition|deadlock\w*|debug\w*|investigat\w*|root cause|performance|optimi[sz]\w*|security|vulnerab\w*|distributed|synchroni[sz]\w*|refactor\w* across|rewrite)\b/i
/** Routine work a light model does well. */
const ROUTINE =
  /\b(readme|docs?|documentation|typos?|comments?|changelog|rename\w*|translat\w*|wording|copy edits?|lint\w*|format\w*|bump\w*|version bump|boilerplate|config(uration)? (change|tweak))\b/i

export interface TaskAssessment {
  tier: ModelTier
  /** Why, in a few words: shown with the model. */
  reason: string
}

/**
 * The tier a task needs. Each sign adds to or takes from a score: a large task, many criteria, many hours, several
 * dependencies or areas of the code, words for demanding work raise it; routine words and a short task lower it.
 */
export function assessTask(task: Pick<PoolTask, 'title' | 'goal' | 'criteria' | 'size' | 'hours' | 'dependsOn' | 'paths'>): TaskAssessment {
  const text = `${task.title} ${task.goal ?? ''} ${(task.criteria ?? []).join(' ')}`
  const signs: { points: number; why: string }[] = []
  const add = (points: number, why: string) => signs.push({ points, why })
  if ((task.size ?? 'large') === 'large') add(1, 'a feature')
  else add(0, 'a small task')
  const criteria = task.criteria?.filter(c => c.trim()).length ?? 0
  if (criteria >= 5) add(1, `${criteria} criteria`)
  if (task.hours !== undefined && task.hours >= 6) add(1, `${task.hours} hours`)
  if (task.hours !== undefined && task.hours <= 1 && (task.size ?? 'large') === 'large') add(-1, 'under an hour')
  if ((task.dependsOn?.length ?? 0) >= 2) add(1, 'built on several tasks')
  const roots = new Set((task.paths ?? []).map(path => path.replace(/^\.?\/+/, '').split('/')[0]).filter(Boolean))
  if (roots.size >= 3) add(1, `${roots.size} parts of the code`)
  const demanding = DEMANDING.exec(text)?.[0]
  if (demanding) add(2, `demanding work (${demanding.toLowerCase()})`)
  else {
    const routine = ROUTINE.exec(text)?.[0]
    if (routine) add(-1, `routine work (${routine.toLowerCase()})`)
  }
  const score = signs.reduce((sum, sign) => sum + sign.points, 0)
  const tier: ModelTier = score <= 0 ? 'light' : score >= 3 ? 'strong' : 'balanced'
  // The signs that pushed it where it is: up for a balanced or strong task, down for a light one.
  const telling = signs.filter(sign => (tier === 'light' ? sign.points <= 0 : sign.points > 0)).map(sign => sign.why)
  return { tier, reason: telling.join(', ') || 'an ordinary task' }
}

// MARK: Choosing the model

export interface ModelChoiceInput {
  task: PoolTask
  tool: 'claude' | 'opencode'
  /** The machine owner's: from its order, which only the owner can seal. */
  policy?: PoolModelPolicy
  /** Why the account should spare its plan now (close to its limit), or null. */
  spare?: string | null
}

export interface ModelChoice {
  tier: ModelTier
  /** What the session is started or switched with. */
  model: string
  /** Why this one, in a sentence for the pool: the task, then any lock, override, escalation or fallback. */
  reason: string
  /** Tiers climbed after the task's sessions failed it. */
  escalated: number
}

/** The tiers the owner allows, lowest first: all of them unless the policy names some it knows. */
export function allowedTiers(policy: PoolModelPolicy | undefined): ModelTier[] {
  const named = policy?.allowed?.filter(isModelTier)
  return MODEL_TIERS.filter(tier => !named?.length || named.includes(tier))
}

/** The model a tier stands for on the machine: the owner's, else the default one. */
export function tierModel(policy: PoolModelPolicy | undefined, tier: ModelTier): string {
  const own = policy?.tiers?.[tier]
  return isModelId(own) ? own : DEFAULT_TIER_MODELS[tier]
}

/**
 * The model the task runs on. In order: the owner's lock, which nothing overrides; else the task's own
 * tier, set by the orchestrator or an admin; else its assessment, one tier up per time a session failed it (bounded by
 * the owner's limit), one tier down from strong while the account spares its plan. Then the nearest tier the owner
 * allows: up first, since a weaker model would fail the task, down when there is none above.
 */
export function chooseModel({ task, policy, spare }: ModelChoiceInput): ModelChoice {
  const allowed = allowedTiers(policy)
  const lock = policy?.lock
  if (isModelTier(lock)) {
    // The more precise of the owner's two choices: a lock outside the tiers it allows is still what it asked for.
    return { tier: lock, model: tierModel(policy, lock), reason: `locked to ${lock} by its owner`, escalated: 0 }
  }
  const reasons: string[] = []
  let wanted: ModelTier
  let escalated = 0
  if (isModelTier(task.model)) {
    wanted = task.model
    reasons.push(`set to ${wanted} for this task`)
  } else {
    const assessed = assessTask(task)
    wanted = assessed.tier
    reasons.push(assessed.reason)
    const limit = Math.min(MAX_ESCALATIONS, Math.max(0, policy?.escalations ?? DEFAULT_ESCALATIONS))
    const setbacks = Math.max(0, task.setbacks ?? 0)
    escalated = Math.min(setbacks, limit, MODEL_TIERS.length - 1 - MODEL_TIERS.indexOf(wanted))
    if (escalated) {
      wanted = MODEL_TIERS[MODEL_TIERS.indexOf(wanted) + escalated]
      reasons.push(
        `up ${escalated === 1 ? 'a tier' : `${escalated} tiers`} after ${setbacks === 1 ? 'a session' : `${setbacks} sessions`} failed it`,
      )
    } else if (setbacks && limit) reasons.push('already on the strongest tier')
    else if (setbacks) reasons.push('its owner allows no escalation')
    if (spare && wanted === 'strong' && !escalated) {
      wanted = 'balanced'
      reasons.push(`balanced while the account ${spare}`)
    }
  }
  const above = allowed.filter(tier => MODEL_TIERS.indexOf(tier) >= MODEL_TIERS.indexOf(wanted))
  const tier = above[0] ?? (allowed[allowed.length - 1] as ModelTier)
  if (tier !== wanted) reasons.push(`${tier} as its owner does not allow ${wanted}`)
  return { tier, model: tierModel(policy, tier), reason: reasons.join('; '), escalated }
}

/**
 * Whether a session runs on the model it was asked for: an alias names its family (`sonnet` in `claude-sonnet-4-5`), an
 * id may come back with its date (`claude-opus-4-5-20251101`), an OpenCode family with its provider.
 */
export function modelMatches(asked: string, runs: string): boolean {
  const a = asked.toLowerCase()
  const r = runs.toLowerCase()
  return r.includes(a)
}

/** One line for the pool's timeline and the orchestrator: what the task runs on and why. */
export function choiceText(choice: ModelChoice): string {
  return `${choice.model} (${choice.tier}): ${choice.reason}`
}

/** A route in a line: `opus (strong): a feature; up a tier after a session failed it`, and what came of it. */
export function routeView(route: PoolTaskRoute): string {
  const head = `${route.model ?? 'its default model'}${route.tier ? ` (${route.tier})` : ''}`
  const after = route.confirmed ? `; runs on ${route.confirmed}` : route.problem ? `; ${route.problem}` : ''
  return `${head}${route.reason ? `: ${route.reason}` : ''}${after}`
}

// MARK: The owner's form

/** What the owner sees and changes of a machine's policy: every tier spelled out, the defaults shown as they apply. */
export interface ModelPolicyForm {
  /** `auto`: each task gets the tier it needs; a tier: every task runs on it. */
  lock: 'auto' | ModelTier
  allowed: ModelTier[]
  /** Empty: the tier's default model. */
  tiers: Record<ModelTier, string>
  escalations: number
}

export function modelPolicyForm(policy: PoolModelPolicy | undefined): ModelPolicyForm {
  return {
    lock: isModelTier(policy?.lock) ? policy.lock : 'auto',
    allowed: allowedTiers(policy),
    tiers: {
      light: isModelId(policy?.tiers?.light) ? policy.tiers.light : '',
      balanced: isModelId(policy?.tiers?.balanced) ? policy.tiers.balanced : '',
      strong: isModelId(policy?.tiers?.strong) ? policy.tiers.strong : '',
    },
    escalations: count(policy?.escalations, MAX_ESCALATIONS) ?? DEFAULT_ESCALATIONS,
  }
}

/**
 * The policy the form stands for, without what is already the default, so a machine the owner left as it was seals
 * none: undefined. Or why it can't be sealed.
 */
export function modelPolicyFromForm(form: ModelPolicyForm): PoolModelPolicy | undefined | string {
  const allowed = MODEL_TIERS.filter(tier => form.allowed.includes(tier))
  if (!allowed.length) return 'Allow at least one tier.'
  const tiers: Partial<Record<ModelTier, string>> = {}
  for (const tier of MODEL_TIERS) {
    const model = form.tiers[tier].trim()
    if (!model || model === DEFAULT_TIER_MODELS[tier]) continue
    if (!isModelId(model)) return `${model} is not a model name: use an alias, a model id or provider/model.`
    tiers[tier] = model
  }
  if (count(form.escalations, MAX_ESCALATIONS) === undefined) return `A task climbs 0 to ${MAX_ESCALATIONS} tiers.`
  const policy = defined({
    lock: form.lock === 'auto' ? undefined : form.lock,
    allowed: allowed.length < MODEL_TIERS.length ? allowed : undefined,
    tiers: Object.keys(tiers).length ? tiers : undefined,
    escalations: form.escalations === DEFAULT_ESCALATIONS ? undefined : form.escalations,
  })
  return Object.keys(policy).length ? policy : undefined
}

/** The policy in a few words, for a machine's card: undefined for the default one. */
export function modelPolicyView(policy: PoolModelPolicy | undefined): string | undefined {
  if (!policy) return undefined
  if (isModelTier(policy.lock)) return `always ${tierModel(policy, policy.lock)}`
  const allowed = allowedTiers(policy)
  const parts = [allowed.length < MODEL_TIERS.length ? allowed.map(tier => tierModel(policy, tier)).join(', ') : 'models by task']
  const escalations = policy.escalations ?? DEFAULT_ESCALATIONS
  if (escalations !== DEFAULT_ESCALATIONS) parts.push(escalations ? `up to ${escalations} tiers up` : 'no escalation')
  return parts.join(' · ')
}
