// The wardrobe: every cosmetic as a tile framed by its rarity, one row per slot. A click tries it on the big Tonton, a
// second click on the same tile wears it, or takes it off. Locked tiles can be tried on too.
import { CheckIcon, LockIcon } from 'lucide-react'
import { RPG_CATALOG, RPG_RARITIES, RPG_SLOTS, type RPGItem, type RPGState } from '../../../shared'
import { RARITY_COLORS, RARITY_LABELS, SLOT_LABELS } from '../../hero'
import { cn } from '../ui/cn'
import { HeroAvatar } from './avatar'

/** Heavier frames for rarer things, so rarity reads without its color too. */
const FRAME_WIDTH = [1, 2, 2, 3, 3]

interface Props {
  hero: RPGState
  preview: RPGItem | null
  onPick: (item: RPGItem) => void
}

export function Wardrobe({ hero, preview, onPick }: Props) {
  return (
    <section className="flex flex-col gap-4" aria-label="Wardrobe">
      <p className="text-sm text-muted-foreground">Click a tile to try it on, click it again to wear it.</p>
      {RPG_SLOTS.map(slot => (
        <div key={slot} className="space-y-2">
          <h3 className="eyebrow">{SLOT_LABELS[slot]}</h3>
          <div className="grid grid-cols-5 gap-2 sm:grid-cols-[repeat(5,minmax(0,112px))]">
            {RPG_CATALOG.filter(item => item.slot === slot).map(item => (
              <Tile key={item.id} hero={hero} item={item} previewing={preview?.id === item.id} onPick={onPick} />
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}

function Tile({ hero, item, previewing, onPick }: { hero: RPGState; item: RPGItem; previewing: boolean; onPick: (item: RPGItem) => void }) {
  const owned = hero.owned.includes(item.id)
  const worn = hero.equipped[item.slot] === item.id
  const rarity = RARITY_LABELS[item.rarity]
  const state = worn ? 'worn' : owned ? 'owned' : 'locked'
  return (
    <button
      type="button"
      aria-pressed={previewing}
      aria-label={`${rarity} ${SLOT_LABELS[item.slot].toLowerCase()}, ${state}${previewing ? ', trying on' : ''}`}
      onClick={() => onPick(item)}
      className={cn(
        'relative flex aspect-square min-w-0 flex-col items-center justify-center gap-0.5 rounded-md bg-white p-1 outline-none transition-transform focus-visible:ring-2 focus-visible:ring-ring/60 motion-safe:hover:-translate-y-0.5',
        previewing && 'ring-2 ring-primary ring-offset-2',
      )}
      style={{ border: `${FRAME_WIDTH[RPG_RARITIES.indexOf(item.rarity)]}px solid ${RARITY_COLORS[item.rarity]}` }}
    >
      <HeroAvatar
        equipped={{ ...hero.equipped, [item.slot]: item.id }}
        size={72}
        label=""
        className={cn('h-auto max-w-full', !owned && 'opacity-35 grayscale')}
      />
      <span className="max-w-full truncate text-[9px] font-medium text-muted-foreground sm:text-[10px]">{rarity}</span>
      {worn && (
        <span className="absolute end-1 top-1 rounded-full bg-foreground p-0.5 text-white" title="Wearing">
          <CheckIcon className="size-2.5" aria-hidden="true" />
        </span>
      )}
      {!owned && (
        <span className="absolute end-1 top-1 text-muted-foreground" title="Locked">
          <LockIcon className="size-3" aria-hidden="true" />
        </span>
      )}
    </button>
  )
}
