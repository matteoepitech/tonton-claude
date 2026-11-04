// What the hero screen says, apart from how a page draws it: the level ring and its title, the journal's lines, Tonton's
// pose from the sessions, and his 24 × 24 pixels with what he wears, from shared/rpg-art.json, the art the notch draws
// too. The website (web/site/rpg.tsx) and the island (desktop/src/renderer/hero.ts) draw from it; no DOM here.

import {
  isLive,
  mostUrgent,
  needsAttention,
  RPG_CATALOG,
  RPG_RARITIES,
  type RPGJournalEntry,
  type RPGRarity,
  type RPGSlot,
  type RPGState,
  rpgLevel,
  rpgThreshold,
} from '../shared'
import type { SessionStatus } from '../shared/protocol'
import sheet from '../shared/rpg-art.json'

export type HeroPose = 'working' | 'resting' | 'attention' | 'cheer'
type Point = readonly number[]
type Anchor = 'head' | 'eyes' | 'center' | 'feet'

export interface HeroArt {
  size: number
  titles: readonly string[]
  colors: Readonly<Record<string, string>>
  ramps: Readonly<Record<string, Readonly<Record<string, string>>>>
  poses: Readonly<Record<string, { ms: number; frames: readonly { rows: readonly string[]; anchors: Readonly<Record<string, Point>> }[] }>>
  layers: Readonly<Record<string, Readonly<Record<string, { anchor: string; origin: Point; frames: readonly (readonly string[])[] }>>>>
  order: readonly string[]
}

export const HERO_ART: HeroArt = sheet
export const MAX_LEVEL = 100

export interface HeroPixel {
  x: number
  y: number
  color: string
}

const RAMP_KEYS = new Set(['O', '1', '2', '3'])
const mod = (n: number, length: number) => ((n % length) + length) % length

/** The rarity of what fills a slot, when it is a known item of that slot. An unknown id dresses nothing. */
export function equippedRarity(equipped: Partial<Record<RPGSlot, string>>, slot: RPGSlot): RPGRarity | null {
  const id = equipped[slot]
  return RPG_CATALOG.find(item => item.id === id && item.slot === slot)?.rarity ?? null
}

/**
 * Tonton in `pose` at `tick` (floor(now / the pose's ms), 0 with reduced motion), back to front in the art's order. Each
 * layer lands at the current frame's anchor, so a hat follows the breathing. Unknown characters and pixels off the canvas
 * are skipped, never an error: the art can grow before the code does.
 */
export function heroPixels(equipped: Partial<Record<RPGSlot, string>>, pose: HeroPose, tick: number, art: HeroArt = HERO_ART): HeroPixel[] {
  const sprite = art.poses[pose] ?? art.poses.working
  const frame = sprite?.frames[mod(tick, sprite.frames.length)]
  if (!frame) return []
  const grid = new Map<number, HeroPixel>()
  const paint = (rows: readonly string[], dx: number, dy: number, ramp: Readonly<Record<string, string>> | undefined) => {
    rows.forEach((row, y) => {
      ;[...row].forEach((char, x) => {
        const color = RAMP_KEYS.has(char) ? ramp?.[char] : art.colors[char]
        const at = { x: x + dx, y: y + dy }
        if (!color || at.x < 0 || at.y < 0 || at.x >= art.size || at.y >= art.size) return
        grid.set(at.y * art.size + at.x, { ...at, color })
      })
    })
  }
  for (const part of art.order) {
    if (part === 'body') {
      paint(frame.rows, 0, 0, art.ramps[equippedRarity(equipped, 'skin') ?? 'base'])
      continue
    }
    const rarity = equippedRarity(equipped, part as RPGSlot)
    const layer = rarity ? art.layers[part]?.[rarity] : undefined
    const anchor = layer ? frame.anchors[layer.anchor as Anchor] : undefined
    const rows = layer?.frames.length ? layer.frames[mod(tick, layer.frames.length)] : undefined
    if (!layer || !anchor || !rows || !rarity) continue
    paint(rows, anchor[0] - layer.origin[0], anchor[1] - layer.origin[1], art.ramps[rarity])
  }
  return [...grid.values()]
}

export interface HeroRun extends HeroPixel {
  width: number
}

/** Pixels of one color side by side in a row, as one rectangle: a few dozen elements per Tonton instead of hundreds. */
export function heroRuns(pixels: readonly HeroPixel[]): HeroRun[] {
  const sorted = [...pixels].sort((a, b) => a.y - b.y || a.x - b.x)
  // Built in place: the list is new and nobody else holds it, and copying it per pixel would cost a frame's time.
  const runs: HeroRun[] = []
  for (const pixel of sorted) {
    const last = runs.at(-1)
    if (last && last.y === pixel.y && last.color === pixel.color && last.x + last.width === pixel.x) last.width++
    else runs.push({ ...pixel, width: 1 })
  }
  return runs
}

/** How long one frame of a pose shows. */
export const poseInterval = (pose: HeroPose, art: HeroArt = HERO_ART): number => Math.max(100, art.poses[pose]?.ms ?? 500)

/** Working while a session works, attention while one waits for the user, resting otherwise: the notch's rule. */
export function heroPose(statuses: readonly SessionStatus[]): HeroPose {
  const status = mostUrgent(statuses.filter(isLive))
  if (status && needsAttention(status)) return 'attention'
  return status === 'working' || status === 'starting' ? 'working' : 'resting'
}

// MARK: Level

/** One title per ten levels. */
export function levelTitle(level: number, art: HeroArt = HERO_ART): string {
  const titles = art.titles
  return titles[Math.max(0, Math.min(titles.length - 1, Math.floor((level - 1) / 10)))] ?? ''
}

export interface HeroProgress {
  level: number
  title: string
  /** Of the way from this level to the next, 0 to 1; 1 at the last level. */
  fraction: number
  /** XP still to earn for the next level, null at the last one. */
  toNext: number | null
}

export function heroProgress(xp: number): HeroProgress {
  const level = rpgLevel(xp)
  const title = levelTitle(level)
  if (level >= MAX_LEVEL) return { level, title, fraction: 1, toNext: null }
  const floor = rpgThreshold(level)
  const next = rpgThreshold(level + 1)
  return { level, title, fraction: Math.min(1, Math.max(0, (xp - floor) / (next - floor))), toNext: Math.max(0, next - xp) }
}

export const number = (n: number): string => n.toLocaleString('en-US')

/** "230 XP to level 8", under the ring. */
export function progressText(progress: HeroProgress): string {
  return progress.toNext === null ? 'Highest level reached' : `${number(progress.toNext)} XP to level ${progress.level + 1}`
}

export interface HeroGain {
  xp: number
  /** The level reached, when the gain crossed one. */
  level: number | null
}

/** What changed between two readings of the same hero: XP to float into the ring, and a level-up to celebrate. */
export function heroGain(before: { xp: number } | null, after: { xp: number }): HeroGain | null {
  if (!before || after.xp <= before.xp) return null
  const from = rpgLevel(before.xp)
  const to = rpgLevel(after.xp)
  return { xp: after.xp - before.xp, level: to > from ? to : null }
}

// MARK: Today

export interface HourBar {
  /** The UTC hour, 0 to 23. */
  hour: number
  /** The reader's time this UTC hour starts at: "14:00", or "05:30" where the offset has half hours. */
  label: string
  xp: number
}

/**
 * Today's bars in the reader's time. Days are UTC days, so the bars stay in UTC order and only their labels move: for
 * Paris the day runs from 01 to 00, for San Francisco from 16 to 15.
 */
export function hourBars(hours: readonly number[], day: string): HourBar[] {
  return Array.from({ length: 24 }, (_, hour) => {
    const at = new Date(`${day}T${String(hour).padStart(2, '0')}:00:00Z`)
    const local = Number.isFinite(at.getTime()) ? { h: at.getHours(), m: at.getMinutes() } : { h: hour, m: 0 }
    const label = `${String(local.h).padStart(2, '0')}:${String(local.m).padStart(2, '0')}`
    return { hour, label, xp: Math.max(0, hours[hour] ?? 0) }
  })
}

/** "4 days in a row", as the notch says it. */
/** What the bars say to a screen reader: the day's XP and its busiest hour, in the reader's time. */
export function hoursSummary(bars: readonly HourBar[]): string {
  const total = bars.reduce((sum, bar) => sum + bar.xp, 0)
  const peak = bars.reduce<HourBar | null>((best, bar) => (bar.xp > (best?.xp ?? 0) ? bar : best), null)
  return peak ? `${number(total)} XP today, most at ${peak.label} (${number(peak.xp)} XP)` : 'No XP yet today'
}

export const streakText = (days: number): string => (days === 1 ? '1 day in a row' : `${number(days)} days in a row`)

/**
 * The last seven days, today last, lit for the days of the streak. The streak ends yesterday until today's first turn
 * (shared/rpg-journal.ts), so today stays dark until then.
 */
export function streakSquares(state: RPGState, streak: number, now: number = Date.now()): boolean[] {
  const today = new Date(now).toISOString().slice(0, 10)
  const started = (state.gains ?? []).some(gain => gain.kind === 'day' && gain.day === today)
  // Squares from the right: today is 0. Without today's turn yet, the streak's last day is yesterday, square 1.
  const last = started ? 0 : 1
  return Array.from({ length: 7 }, (_, i) => {
    const back = 6 - i
    return streak > 0 && back >= last && back < last + streak
  })
}

/** The UTC hour `now` falls in, when `day` is today: the bar to show in full. */
export const currentHour = (day: string, now: number = Date.now()): number | null =>
  new Date(now).toISOString().slice(0, 10) === day ? new Date(now).getUTCHours() : null

/**
 * The level ring cut in segments, filling clockwise: dash patterns for a circle of `radius` whose stroke starts at
 * 12 o'clock (the drawing turns it a quarter back). The track has every segment, the fill the first `fraction` of them.
 */
export function ringSegments(radius: number, fraction: number, count = 36, gap = 2.5): { track: string; fill: string } {
  const circumference = 2 * Math.PI * radius
  const step = circumference / count
  const dash = Math.max(0.5, step - gap)
  const filled = Math.max(0, Math.min(count, Math.floor(fraction * count + 1e-9)))
  const pattern = (n: number) => Array.from({ length: n }, () => `${dash.toFixed(3)} ${(step - dash).toFixed(3)}`)
  return {
    track: pattern(1).join(' '),
    fill: filled ? [...pattern(filled), `0 ${circumference.toFixed(3)}`].join(' ') : `0 ${circumference.toFixed(3)}`,
  }
}

// MARK: Journal

/** "13 minutes of work in tonton-claude", "pushed main", "checklist task": why the XP came, as the notch says it. */
export function journalReason(entry: RPGJournalEntry): string {
  switch (entry.kind) {
    case 'turn': {
      const minutes = Math.floor((entry.seconds ?? 0) / 60)
      if (minutes < 1) return 'answered prompt'
      const work = `${number(minutes)} ${minutes === 1 ? 'minute' : 'minutes'} of work`
      return entry.note ? `${work} in ${entry.note}` : work
    }
    case 'day':
      return 'first turn of the day'
    case 'push':
      return entry.note ? `pushed ${entry.note}` : 'pushed a commit'
    case 'task':
      return 'checklist task'
    case 'poolTask':
      return 'pool task'
    case 'review':
      return 'accepted review'
    case 'encounter':
      return 'arena encounter'
    case 'boss':
      return 'boss defeated'
  }
}

/** "+18 · 13 minutes of work in tonton-claude". */
export const journalLine = (entry: RPGJournalEntry): string => `+${number(entry.xp)} · ${journalReason(entry)}`

/** When it came, in the reader's time: today's hour, or the day. */
export function journalTime(entry: RPGJournalEntry, now: Date = new Date()): string {
  const at = entry.at ? new Date(entry.at) : null
  if (at && Number.isFinite(at.getTime())) {
    const sameDay = at.toDateString() === now.toDateString()
    return sameDay
      ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : at.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }
  const day = new Date(`${entry.day}T00:00:00Z`)
  return Number.isFinite(day.getTime()) ? day.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' }) : ''
}

// MARK: Wardrobe

export const RARITY_COLORS: Record<RPGRarity, string> = Object.fromEntries(
  RPG_RARITIES.map(rarity => [
    rarity,
    `#${(RPG_CATALOG.find(item => item.rarity === rarity)?.color ?? 0x888888).toString(16).padStart(6, '0')}`,
  ]),
) as Record<RPGRarity, string>

export const SLOT_LABELS: Record<RPGSlot, string> = { skin: 'Skin', hat: 'Hat', accessory: 'Accessory', aura: 'Aura', trail: 'Trail' }

export const RARITY_LABELS: Record<RPGRarity, string> = {
  common: 'Common',
  uncommon: 'Uncommon',
  rare: 'Rare',
  epic: 'Epic',
  legendary: 'Legendary',
}

/** A booster's source, from its id: `level-N`, `boss-v1-…`, `achievement-v1-…`, `team-v1-…`. */
export function boosterSource(id: string): string {
  const level = /^level-(\d+)$/.exec(id)
  if (level) return `Level ${level[1]}`
  if (id.startsWith('boss-')) return 'Boss victory'
  if (id.startsWith('achievement-')) return 'Achievement'
  if (id.startsWith('team-')) return 'Team goal'
  return 'Booster'
}

// MARK: Small

/**
 * Under 32 px the 24 × 24 art is too fine: Tonton is the notch's 12 × 12 mascot there, the frames of
 * app/Sources/TontonCore/Mascot.swift, in the color of his skin. `#` body, `o` eye, `-` closed eye, `h` hand,
 * `k` keyboard, `z` a snore.
 */
const HEAD = ['............', '....####....', '...######...', '..########..']
const EYES = ['..#oo##oo#..', '..#oo##oo#..', '..########..', '...######...']
const EMPTY = ['............', '............', '............', '............']
const MASCOT: Record<HeroPose, readonly (readonly string[])[]> = {
  working: [
    [...HEAD, ...EYES, '..h......h..', 'kkkkkkkkkkkk', '............', '............'],
    [...HEAD, ...EYES, '...h....h...', 'kkkkkkkkkkkk', '............', '............'],
  ],
  resting: [
    [
      '..........z.',
      '....####...z',
      '...######...',
      '..########..',
      '..########..',
      '..#--##--#..',
      '..########..',
      '...######...',
      ...EMPTY,
    ],
    [
      '............',
      '....####..z.',
      '...######...',
      '..########..',
      '..########..',
      '..#--##--#..',
      '..########..',
      '...######...',
      ...EMPTY,
    ],
  ],
  attention: [
    ['..........h.', '....####..h.', '...######.h.', '..########h.', ...EYES, ...EMPTY],
    ['............', '....####...h', '...######.h.', '..########h.', ...EYES, ...EMPTY],
  ],
  cheer: [
    ['..........h.', '....####..h.', '...######.h.', '..########h.', ...EYES, ...EMPTY],
    ['............', '....####...h', '...######.h.', '..########h.', ...EYES, ...EMPTY],
  ],
}
const MASCOT_COLORS: Record<string, string> = { o: '#ffffff', '-': '#1e1d2b', h: '#a5a4ff', k: '#777777', z: '#a5a4ff' }

export const MASCOT_SIZE = 12

/** The small Tonton's pixels: his body in the middle shade of his skin. */
export function mascotPixels(
  equipped: Partial<Record<RPGSlot, string>>,
  pose: HeroPose,
  tick: number,
  art: HeroArt = HERO_ART,
): HeroPixel[] {
  const frames = MASCOT[pose]
  const rows = frames[mod(tick, frames.length)] ?? []
  const body = art.ramps[equippedRarity(equipped, 'skin') ?? 'base']?.['2'] ?? '#ffbc83'
  return rows.flatMap((row, y) =>
    [...row].flatMap((char, x) => {
      const color = char === '#' ? body : MASCOT_COLORS[char]
      return color ? [{ x, y, color }] : []
    }),
  )
}
