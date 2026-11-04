// shared/rpg-art.json is drawn by the website and, through its copy in TontonCore, by the Mac: whole squares, every
// cosmetic of the catalog, a colour for every character. HeroArtTests checks the same on the Swift side.
import { expect, test } from 'bun:test'
import { RPG_RARITIES, RPG_SLOTS } from '../rpg'
import art from '../rpg-art.json'

const shades = new Set(['O', '1', '2', '3'])
const known = (row: string) => [...row].every(c => c === '.' || shades.has(c) || c in art.colors)
const hex = /^#[0-9a-f]{6}$/

test('every pose is whole 24×24 frames with its four anchors', () => {
  expect(art.size).toBe(24)
  for (const pose of ['idle', 'working', 'resting', 'attention', 'cheer'] as const) {
    const { ms, frames } = art.poses[pose]
    expect(ms).toBeGreaterThan(100)
    expect(frames.length).toBeGreaterThan(1)
    for (const frame of frames) {
      expect(frame.rows).toHaveLength(24)
      for (const row of frame.rows) expect([row, row.length, known(row)]).toEqual([row, 24, true])
      expect(Object.keys(frame.anchors).sort()).toEqual(['center', 'eyes', 'feet', 'head'])
    }
  }
})

test('every cosmetic of the catalog has a mask, and every rarity a ramp', () => {
  for (const key of ['base', ...RPG_RARITIES]) {
    const ramp = art.ramps[key as keyof typeof art.ramps]
    expect(Object.keys(ramp).sort()).toEqual(['1', '2', '3', 'O'])
    for (const color of Object.values(ramp)) expect(color).toMatch(hex)
  }
  for (const color of Object.values(art.colors)) expect(color).toMatch(hex)
  for (const slot of RPG_SLOTS.filter(s => s !== 'skin')) {
    for (const rarity of RPG_RARITIES) {
      const layer = art.layers[slot as keyof typeof art.layers][rarity]
      expect(layer.frames.length).toBeGreaterThan(0)
      for (const row of layer.frames.flat()) expect([slot, rarity, row, known(row)]).toEqual([slot, rarity, row, true])
    }
  }
  expect([...art.order].sort()).toEqual(['accessory', 'aura', 'body', 'hat', 'trail'])
})

test('one title per ten levels', () => {
  expect(art.titles).toHaveLength(10)
  expect(new Set(art.titles).size).toBe(10)
})
