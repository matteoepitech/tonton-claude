// The hero screen's view model (web/hero.ts), which the website and the island draw: the level ring, titles, the
// journal's wording, the pose, and the compositing of shared/rpg-art.json with what Tonton wears. The art file's own
// shape is shared/test/rpg-art.test.ts's.
import { describe, expect, test } from 'bun:test'
import { newRPGState, type RPGJournalEntry, type RPGReceipt, type RPGSlot, rpgThreshold } from '../../shared'
import vectors from '../../shared/test/rpg-art-vectors.json'
import {
  currentHour,
  HERO_ART,
  type HeroArt,
  type HeroPose,
  heroGain,
  heroPixels,
  heroPose,
  heroProgress,
  heroRuns,
  hourBars,
  hoursSummary,
  journalLine,
  levelTitle,
  MASCOT_SIZE,
  mascotPixels,
  progressText,
  ringSegments,
  streakSquares,
  streakText,
} from '../hero'

const entry = (kind: RPGJournalEntry['kind'], xp: number, extra: Partial<RPGJournalEntry> = {}): RPGJournalEntry => ({
  id: 'a'.repeat(64),
  kind,
  xp,
  sparks: 0,
  day: '2026-11-04',
  ...extra,
})

describe('compositing', () => {
  const tiny: HeroArt = {
    size: 4,
    titles: ['One'],
    colors: { x: '#000000' },
    ramps: { base: { O: '#b0', '1': '#b1', '2': '#b2', '3': '#b3' }, rare: { O: '#r0', '1': '#r1', '2': '#r2', '3': '#r3' } },
    poses: {
      working: {
        ms: 100,
        frames: [
          { rows: ['....', '.22.', '.2?.', '....'], anchors: { head: [1, 0], eyes: [1, 1], center: [2, 2], feet: [1, 3] } },
          { rows: ['....', '....', '.22.', '.22.'], anchors: { head: [1, 1], eyes: [1, 2], center: [2, 2], feet: [1, 3] } },
        ],
      },
    },
    layers: {
      hat: { rare: { anchor: 'head', origin: [0, 0], frames: [['xO']] } },
      trail: { rare: { anchor: 'feet', origin: [0, 0], frames: [['2222']] } },
    },
    order: ['body', 'trail', 'hat'],
  }

  test('the body takes the skin ramp, unknown characters are skipped', () => {
    const base = heroPixels({}, 'working', 0, tiny)
    expect(base).toHaveLength(3)
    expect(new Set(base.map(p => p.color))).toEqual(new Set(['#b2']))
    const rare = heroPixels({ skin: 'skin-rare' }, 'working', 0, tiny)
    expect(rare.every(p => p.color === '#r2')).toBe(true)
  })

  test('a layer lands on the frame anchor and follows it, later layers cover earlier ones, nothing leaves the canvas', () => {
    const at = (tick: number) => heroPixels({ hat: 'hat-rare', trail: 'trail-rare' }, 'working', tick, tiny)
    expect(at(0)).toContainEqual({ x: 1, y: 0, color: '#000000' })
    expect(at(0)).toContainEqual({ x: 2, y: 0, color: '#r0' })
    // The second frame moved the head down one pixel.
    expect(at(1)).toContainEqual({ x: 1, y: 1, color: '#000000' })
    // The trail starts at x 1 on the feet: its last pixel would be x 4, off the 4 × 4 canvas.
    expect(
      at(0)
        .filter(p => p.y === 3)
        .map(p => p.x),
    ).toEqual([1, 2, 3])
    // The frame loops with the tick, negative ticks too.
    expect(at(2)).toEqual(at(0))
    expect(at(-1)).toEqual(at(1))
  })

  test('unknown items dress nothing', () => {
    expect(heroPixels({ hat: 'hat-mythic', trail: 'hat-rare' }, 'working', 0, tiny)).toEqual(heroPixels({}, 'working', 0, tiny))
  })

  test('the real art draws Tonton in every pose, dressed or not', () => {
    for (const pose of ['working', 'resting', 'attention', 'cheer', 'idle'] as const) {
      const bare = heroPixels({}, pose, 0)
      const dressed = heroPixels({ skin: 'skin-epic', hat: 'hat-legendary', accessory: 'accessory-rare', aura: 'aura-uncommon' }, pose, 0)
      expect(bare.length).toBeGreaterThan(50)
      expect(dressed).not.toEqual(bare)
      for (const p of dressed) expect(p.x >= 0 && p.x < 24 && p.y >= 0 && p.y < 24).toBe(true)
    }
  })

  test('the shared vectors: the notch draws the same pixels (TontonCore checks the same file)', async () => {
    for (const vector of vectors) {
      const pixels = heroPixels(vector.equipped as Partial<Record<RPGSlot, string>>, vector.pose as HeroPose, vector.tick)
      const text = [...pixels]
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .map(p => `${p.x},${p.y},${p.color}`)
        .join(';')
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
      expect({ pixels: pixels.length, sha256: [...digest].map(b => b.toString(16).padStart(2, '0')).join('') }).toEqual({
        pixels: vector.pixels,
        sha256: vector.sha256,
      })
    }
  })

  test('runs merge neighbours of one color in a row', () => {
    const runs = heroRuns([
      { x: 2, y: 0, color: 'a' },
      { x: 0, y: 0, color: 'a' },
      { x: 1, y: 0, color: 'a' },
      { x: 3, y: 0, color: 'b' },
      { x: 0, y: 1, color: 'b' },
    ])
    expect(runs).toEqual([
      { x: 0, y: 0, color: 'a', width: 3 },
      { x: 3, y: 0, color: 'b', width: 1 },
      { x: 0, y: 1, color: 'b', width: 1 },
    ])
  })

  test('the small mascot is 12 × 12 in the color of the skin', () => {
    const pixels = mascotPixels({ skin: 'skin-rare' }, 'resting', 0)
    expect(pixels.every(p => p.x < MASCOT_SIZE && p.y < MASCOT_SIZE)).toBe(true)
    expect(pixels.some(p => p.color === HERO_ART.ramps.rare?.['2'])).toBe(true)
  })
})

describe('level', () => {
  test('the ring fills from one level to the next, and says what is left', () => {
    expect(heroProgress(0)).toEqual({ level: 1, title: levelTitle(1), fraction: 0, toNext: 100 })
    const seven = heroProgress(rpgThreshold(7) + 470)
    expect(seven.level).toBe(7)
    expect(seven.toNext).toBe(rpgThreshold(8) - rpgThreshold(7) - 470)
    expect(progressText(heroProgress(rpgThreshold(8) - 230))).toBe('230 XP to level 8')
    expect(progressText(heroProgress(rpgThreshold(42) + 1))).toBe('4,199 XP to level 43')
    expect(heroProgress(rpgThreshold(100) + 5)).toMatchObject({ level: 100, fraction: 1, toNext: null })
    expect(progressText(heroProgress(rpgThreshold(100)))).toBe('Highest level reached')
  })

  test('one title per ten levels', () => {
    expect(levelTitle(1)).toBe(HERO_ART.titles[0])
    expect(levelTitle(10)).toBe(HERO_ART.titles[0])
    expect(levelTitle(11)).toBe(HERO_ART.titles[1])
    expect(levelTitle(42)).toBe(HERO_ART.titles[4])
    expect(levelTitle(100)).toBe(HERO_ART.titles[9])
  })

  test('a gain is news only after a first reading, and says when it crossed a level', () => {
    expect(heroGain(null, { xp: 500 })).toBeNull()
    expect(heroGain({ xp: 500 }, { xp: 500 })).toBeNull()
    expect(heroGain({ xp: 90 }, { xp: 108 })).toEqual({ xp: 18, level: 2 })
    expect(heroGain({ xp: 100 }, { xp: 118 })).toEqual({ xp: 18, level: null })
  })
})

describe('journal and today', () => {
  test('each kind says why the XP came', () => {
    expect(journalLine(entry('turn', 18, { seconds: 13 * 60 + 40, note: 'tonton-claude' }))).toBe(
      '+18 · 13 minutes of work in tonton-claude',
    )
    expect(journalLine(entry('turn', 6, { seconds: 61 }))).toBe('+6 · 1 minute of work')
    expect(journalLine(entry('turn', 5, { seconds: 20, note: 'x' }))).toBe('+5 · answered prompt')
    expect(journalLine(entry('push', 15, { note: 'main' }))).toBe('+15 · pushed main')
    expect(journalLine(entry('day', 40))).toBe('+40 · first turn of the day')
    expect(journalLine(entry('task', 10))).toBe('+10 · checklist task')
    expect(journalLine(entry('boss', 1075))).toBe('+1,075 · boss defeated')
  })

  test('hours keep their UTC order and take the reader’s labels', () => {
    const hours = Array.from({ length: 24 }, (_, h) => (h === 13 ? 30 : 0))
    const bars = hourBars(hours, '2026-11-04')
    expect(bars).toHaveLength(24)
    expect(bars[13]?.xp).toBe(30)
    expect(bars.map(b => b.hour)).toEqual(Array.from({ length: 24 }, (_, h) => h))
    const local = new Date('2026-11-04T13:00:00Z')
    expect(bars[13]?.label).toBe(`${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`)
    expect(hoursSummary(bars)).toBe(`30 XP today, most at ${bars[13]?.label} (30 XP)`)
    expect(hoursSummary(hourBars(Array(24).fill(0), '2026-11-04'))).toBe('No XP yet today')
  })

  test('the last seven days light the streak, ending yesterday until today’s first turn', () => {
    const now = Date.parse('2026-11-04T12:00:00Z')
    const day = (d: string): RPGReceipt => ({ id: d.replaceAll('-', '').padStart(64, '0'), kind: 'day', xp: 20, sparks: 2, day: d })
    const hero = (...days: string[]) => ({ ...newRPGState(), gains: days.map(day) })
    expect(streakSquares(hero('2026-11-02', '2026-11-03', '2026-11-04'), 3, now)).toEqual([false, false, false, false, true, true, true])
    expect(streakSquares(hero('2026-11-02', '2026-11-03'), 2, now)).toEqual([false, false, false, false, true, true, false])
    expect(streakSquares(hero(), 0, now)).toEqual(Array(7).fill(false))
    expect(streakSquares(hero('2026-11-04'), 9, now).filter(Boolean)).toHaveLength(7)
    expect(streakText(1)).toBe('1 day in a row')
    expect(streakText(4)).toBe('4 days in a row')
  })

  test('the current hour is lit only on its own day', () => {
    const now = Date.parse('2026-11-04T13:20:00Z')
    expect(currentHour('2026-11-04', now)).toBe(13)
    expect(currentHour('2026-11-03', now)).toBeNull()
  })

  test('the ring fills whole segments, clockwise, and nothing when empty', () => {
    const parts = (dashes: string) => dashes.split(' ').map(Number)
    const empty = ringSegments(50, 0)
    expect(parts(empty.fill)[0]).toBe(0)
    const half = parts(ringSegments(50, 0.5).fill)
    // 18 segments of dash and gap, then a gap as long as the circle.
    expect(half).toHaveLength(18 * 2 + 2)
    expect(half.at(-1)).toBeCloseTo(2 * Math.PI * 50, 2)
    expect(parts(ringSegments(50, 1).fill)).toHaveLength(36 * 2 + 2)
    const [dash, gap] = parts(empty.track)
    expect((dash ?? 0) + (gap ?? 0)).toBeCloseTo((2 * Math.PI * 50) / 36, 2)
  })

  test('the pose follows the sessions: attention first, then work, else rest', () => {
    expect(heroPose(['idle', 'working', 'permission'])).toBe('attention')
    expect(heroPose(['idle', 'starting'])).toBe('working')
    expect(heroPose(['idle', 'ended'])).toBe('resting')
    expect(heroPose(['offline'])).toBe('resting')
    expect(heroPose([])).toBe('resting')
  })
})
