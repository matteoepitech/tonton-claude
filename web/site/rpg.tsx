// The account's private hero, decrypted in the browser. The arena renderer is currently native macOS.
import { useEffect, useRef, useState } from 'react'
import {
  claimRPGMilestones,
  equipRPG,
  openRPGBooster,
  RPG_CATALOG,
  RPG_ODDS,
  RPG_RARITIES,
  RPG_SLOTS,
  RPG_UPGRADES,
  RPGClient,
  type RPGItem,
  type RPGState,
  randomRPGItem,
  rpgLevel,
  rpgMilestones,
  rpgStats,
  upgradeRPG,
} from '../../shared'
import { useStore } from './store'
import { Button } from './ui/button'

export function useHero() {
  const { saved } = useStore()
  const [value, setValue] = useState<{ identity: object; hero: RPGState } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const active = useRef(saved)
  active.current = saved
  const pending = useRef(false)
  useEffect(() => {
    let cancelled = false
    setError(null)
    setBusy(false)
    pending.current = false
    const refresh = async () => {
      if (!saved || pending.current) return
      pending.current = true
      setBusy(true)
      try {
        const result = await new RPGClient(`${saved.relay}/api/rpg`, saved.token, saved.key).read()
        if (!cancelled) {
          setValue({ identity: saved, hero: result.state })
          setError(null)
        }
      } catch {
        if (!cancelled) setError('Could not sync Tonton. Check the connection and relay version.')
      } finally {
        if (!cancelled) {
          pending.current = false
          setBusy(false)
        }
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [saved])
  const change = async (apply: (hero: RPGState) => RPGState): Promise<RPGState | null> => {
    if (!saved || pending.current) return null
    pending.current = true
    setBusy(true)
    try {
      const hero = await new RPGClient(`${saved.relay}/api/rpg`, saved.token, saved.key).change(apply)
      if (active.current !== saved) return null
      setValue({ identity: saved, hero })
      setError(null)
      return hero
    } catch {
      if (active.current === saved) setError('Could not save. Reconnect and retry the same action.')
      return null
    } finally {
      if (active.current === saved) {
        pending.current = false
        setBusy(false)
      }
    }
  }
  return { hero: value?.identity === saved ? value.hero : null, busy, error, change }
}

const frame = [
  '............',
  '....####....',
  '...######...',
  '..########..',
  '..#oo##oo#..',
  '..#oo##oo#..',
  '..########..',
  '...######...',
  '..h......h..',
  'kkkkkkkkkkkk',
  '............',
  '............',
]
export function HeroAvatar({ equipped, size = 48 }: { equipped: Record<string, string | undefined>; size?: number }) {
  const item = (slot: string) => RPG_CATALOG.find(i => i.id === equipped[slot] && i.slot === slot)
  const hex = (color: number) => `#${color.toString(16).padStart(6, '0')}`
  const pixels: { x: number; y: number; color: string }[] = []
  frame.forEach((row, y) => {
    ;[...row].forEach((c, x) => {
      const color =
        c === '#' ? hex(item('skin')?.color ?? 0xffbc83) : c === 'o' ? '#fff' : c === 'h' ? '#a5a4ff' : c === 'k' ? '#777' : null
      if (color) pixels.push({ x, y: y + 1, color })
    })
  })
  const layer = (slot: string, points: number[][]) => {
    const chosen = item(slot)
    if (chosen) for (const [x, y] of points) pixels.push({ x, y, color: hex(chosen.color) })
  }
  const hat = item('hat')
  if (hat)
    layer('hat', [
      ...Array.from({ length: 6 }, (_, i) => [i + 3, 1]),
      ...Array.from({ length: 2 + RPG_RARITIES.indexOf(hat.rarity) }, (_, i) => [i + 4, 0]),
    ])
  layer('accessory', [
    [0, 5],
    [1, 4],
    [1, 5],
    [1, 6],
  ])
  layer('aura', [
    [0, 1],
    [11, 3],
    [0, 9],
    [11, 10],
  ])
  layer('trail', [
    [2, 11],
    [4, 11],
    [6, 11],
  ])
  return (
    <svg viewBox="0 0 12 12" width={size} height={size} role="img" aria-label="Tonton's equipped appearance" shapeRendering="crispEdges">
      {[...new Map(pixels.map(p => [`${p.x}-${p.y}`, p])).values()].map(p => (
        <rect key={`${p.x}-${p.y}`} x={p.x} y={p.y} width="1" height="1" fill={p.color} />
      ))}
    </svg>
  )
}
export function HeroPage() {
  const { hero, busy, error, change } = useHero()
  const [preview, setPreview] = useState<RPGItem | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [slot, setSlot] = useState<(typeof RPG_SLOTS)[number]>('skin')
  useEffect(() => {
    if (!opening) return
    setRevealed(window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    const timer = setTimeout(() => setRevealed(true), 1200)
    return () => clearTimeout(timer)
  }, [opening])
  if (!hero) return <div className="p-6">{error ?? 'Syncing Tonton…'}</div>
  const stats = rpgStats(hero)
  const receipt = opening ? hero.openings[opening] : null
  const drop = RPG_CATALOG.find(i => i.id === receipt?.item)
  return (
    <main className="overflow-y-auto p-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <header className="flex items-center gap-5">
          <HeroAvatar equipped={{ ...hero.equipped, ...(preview ? { [preview.slot]: preview.id } : {}) }} size={96} />
          <div>
            <h1 className="text-2xl font-bold">Tonton · Level {rpgLevel(hero.xp)}</h1>
            <p>
              {hero.xp} XP · {hero.sparks} sparks · {hero.boosters.length} boosters
            </p>
          </div>
        </header>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Wardrobe</h2>
          <div className="flex flex-wrap gap-2">
            {RPG_SLOTS.map(s => (
              <Button
                key={s}
                variant={s === slot ? 'default' : 'outline'}
                onClick={() => {
                  setSlot(s)
                  setPreview(null)
                }}
              >
                {s}
              </Button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {RPG_CATALOG.filter(i => i.slot === slot).map(item => (
              <div key={item.id} className="flex items-center gap-3 rounded-lg border p-3">
                <button type="button" aria-label={`Preview ${item.rarity} ${item.slot}`} onClick={() => setPreview(item)}>
                  <HeroAvatar equipped={{ ...hero.equipped, [slot]: item.id }} />
                </button>
                <span className="flex-1">
                  {item.rarity} {item.slot}
                </span>
                <Button
                  size="sm"
                  disabled={busy || !hero.owned.includes(item.id) || hero.equipped[slot] === item.id}
                  onClick={() => void change(h => equipRPG(h, slot, item.id))}
                >
                  {hero.equipped[slot] === item.id ? 'Equipped' : hero.owned.includes(item.id) ? 'Equip' : 'Locked'}
                </Button>
              </div>
            ))}
          </div>
          <Button variant="outline" disabled={busy || !hero.equipped[slot]} onClick={() => void change(h => equipRPG(h, slot, null))}>
            Unequip {slot}
          </Button>
        </section>
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Boosters</h2>
          <p className="text-sm text-muted-foreground">
            One cosmetic. {RPG_RARITIES.map((r, i) => `${r} ${RPG_ODDS[i]}%`).join(' · ')}. Duplicates become 1 / 3 / 8 / 20 / 50 sparks.
          </p>
          {drop && receipt && (
            <div
              className={`rounded-xl p-6 text-center ${
                {
                  common: 'border border-emerald-300',
                  uncommon: 'border-2 border-sky-300',
                  rare: 'border-2 border-violet-300',
                  epic: 'border-4 border-pink-300',
                  legendary: 'border-4 border-amber-300 motion-safe:animate-pulse',
                }[drop.rarity]
              }`}
              aria-live="polite"
            >
              {revealed ? (
                <>
                  <div className="flex justify-center">
                    <HeroAvatar equipped={{ ...hero.equipped, [drop.slot]: drop.id }} size={96} />
                  </div>
                  <p className="my-3 text-xl">
                    {drop.rarity} {drop.slot}
                  </p>
                  {receipt.duplicateSparks > 0 && <p>Duplicate converted to {receipt.duplicateSparks} sparks.</p>}
                  <Button disabled={busy} onClick={() => void change(h => equipRPG(h, drop.slot, drop.id))}>
                    Equip
                  </Button>
                </>
              ) : (
                <>
                  <p className="motion-safe:animate-pulse">Revealing your cosmetic…</p>
                  <Button onClick={() => setRevealed(true)}>Skip animation</Button>
                </>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {hero.boosters.map(id => (
              <Button
                key={id}
                disabled={busy}
                onClick={async () => {
                  const candidate = randomRPGItem()
                  if (await change(h => openRPGBooster(h, id, candidate.id))) setOpening(id)
                }}
              >
                Open earned booster
              </Button>
            ))}
          </div>
          <details>
            <summary>Previous openings</summary>
            {Object.entries(hero.openings).map(([id, result]) => (
              <Button key={id} variant="ghost" onClick={() => setOpening(id)}>
                {result.item} · {result.duplicateSparks} duplicate sparks
              </Button>
            ))}
          </details>
        </section>
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Hero upgrades</h2>
          {RPG_UPGRADES.map(stat => {
            const rank = hero.upgrades[stat] ?? 0
            const increment = stat === 'health' ? 15 : stat === 'attack' ? 3 : 6
            return (
              <div key={stat} className="flex items-center justify-between rounded-lg border p-3">
                <span>
                  {stat}: {stats[stat]}
                  {rank < 10 && ` → ${stats[stat] + increment}`} · rank {rank}/10
                </span>
                <Button
                  disabled={busy || rank === 10 || hero.sparks < (rank + 1) * 10}
                  onClick={() => void change(h => upgradeRPG(h, stat, rank + 1))}
                >
                  {rank === 10 ? 'Maximum rank' : `Upgrade · ${(rank + 1) * 10} sparks`}
                </Button>
              </div>
            )
          })}
          <p className="text-sm text-muted-foreground">
            Play the arena in the Mac app: Tonton → Hero → Play arena. Combat rewards and upgrades sync here.
          </p>
        </section>
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Achievements</h2>
          {rpgMilestones(hero).map(m => (
            <div key={m.id}>
              <p>
                {m.id === 'rpgWorker'
                  ? 'Team player · 10 work rewards'
                  : m.id === 'rpgVeteran'
                    ? 'Veteran Tonton · 1,000 XP'
                    : 'Boss slayer · first victory'}
              </p>
              <progress className="w-full" aria-label={m.id} value={Math.min(m.done, m.target)} max={m.target} />
            </div>
          ))}
          <Button disabled={busy} onClick={() => void change(claimRPGMilestones)}>
            Claim achievement boosters
          </Button>
        </section>
      </div>
    </main>
  )
}
