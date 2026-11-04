// Boosters: the ones waiting, the reveal of one just opened, and the earlier openings. The draw is committed before the
// reveal plays, so skipping it or reloading never changes what came out (docs/rpg.md).
import { GiftIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  equipRPG,
  openRPGBooster,
  RPG_CATALOG,
  RPG_DUPLICATES,
  RPG_ODDS,
  RPG_RARITIES,
  type RPGState,
  randomRPGItem,
} from '../../../shared'
import { boosterSource, RARITY_COLORS, RARITY_LABELS, SLOT_LABELS } from '../../hero'
import { Empty } from '../common'
import { Button } from '../ui/button'
import { HeroAvatar } from './avatar'
import { useReducedMotion } from './motion'

const REVEAL_MS = 1200

interface Props {
  hero: RPGState
  busy: boolean
  change: (apply: (hero: RPGState) => RPGState) => Promise<RPGState | null>
}

export function Boosters({ hero, busy, change }: Props) {
  const reduced = useReducedMotion()
  const [opening, setOpening] = useState<string | null>(null)
  const [revealed, setRevealed] = useState(false)
  useEffect(() => {
    if (!opening) return
    setRevealed(reduced)
    const timer = setTimeout(() => setRevealed(true), REVEAL_MS)
    return () => clearTimeout(timer)
  }, [opening, reduced])
  const receipt = opening ? hero.openings[opening] : null
  const drop = RPG_CATALOG.find(item => item.id === receipt?.item)
  const earlier = Object.entries(hero.openings).reverse()
  return (
    <section className="flex flex-col gap-4" aria-label="Boosters">
      <p className="text-sm text-muted-foreground">
        One cosmetic each. {RPG_RARITIES.map((rarity, i) => `${RARITY_LABELS[rarity]} ${RPG_ODDS[i]}%`).join(' · ')}. A duplicate becomes{' '}
        {RPG_DUPLICATES.join(' / ')} sparks.
      </p>
      {drop && receipt && (
        <div
          className="flex flex-col items-center gap-3 rounded-lg bg-white p-6 text-center"
          style={{ border: `3px solid ${RARITY_COLORS[drop.rarity]}` }}
          aria-live="polite"
        >
          {revealed ? (
            <>
              <HeroAvatar equipped={{ ...hero.equipped, [drop.slot]: drop.id }} pose="cheer" moving size={120} />
              <p className="text-lg font-semibold">
                {RARITY_LABELS[drop.rarity]} {SLOT_LABELS[drop.slot].toLowerCase()}
              </p>
              {receipt.duplicateSparks > 0 && <p className="text-sm">Already yours: it became {receipt.duplicateSparks} sparks.</p>}
              <Button
                disabled={busy || hero.equipped[drop.slot] === drop.id}
                onClick={() => void change(h => equipRPG(h, drop.slot, drop.id))}
              >
                {hero.equipped[drop.slot] === drop.id ? 'Wearing it' : 'Wear it'}
              </Button>
            </>
          ) : (
            <>
              <GiftIcon className="size-10 text-primary motion-safe:animate-bounce" aria-hidden="true" />
              <p>Opening…</p>
              <Button variant="ghost" size="sm" onClick={() => setRevealed(true)}>
                Skip
              </Button>
            </>
          )}
        </div>
      )}
      {hero.boosters.length ? (
        <ul className="grid gap-2 sm:grid-cols-2">
          {hero.boosters.map(id => (
            <li key={id} className="flex items-center gap-3 rounded-lg border bg-white p-3">
              <span className="icon-tile size-8">
                <GiftIcon className="size-4" aria-hidden="true" />
              </span>
              <span className="flex-1 text-sm font-medium">{boosterSource(id)}</span>
              <Button
                size="sm"
                variant="accent"
                disabled={busy}
                onClick={async () => {
                  // Drawn once, before the transaction: a retried save keeps the same item.
                  const candidate = randomRPGItem()
                  if (await change(h => openRPGBooster(h, id, candidate.id))) setOpening(id)
                }}
              >
                Open
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty className="py-2">No booster waiting. Each level brings one, and so do bosses, achievements and team goals.</Empty>
      )}
      {earlier.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Earlier openings ({earlier.length})</summary>
          <ul className="mt-2 flex flex-wrap gap-2">
            {earlier.map(([id, result]) => {
              const item = RPG_CATALOG.find(i => i.id === result.item)
              return (
                <li key={id}>
                  <Button variant="outline" size="sm" onClick={() => setOpening(id)}>
                    {item ? `${RARITY_LABELS[item.rarity]} ${SLOT_LABELS[item.slot].toLowerCase()}` : result.item}
                    {result.duplicateSparks > 0 ? ` · ${result.duplicateSparks} sparks` : ''}
                  </Button>
                </li>
              )
            })}
          </ul>
        </details>
      )}
    </section>
  )
}
