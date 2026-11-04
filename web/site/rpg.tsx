// The account's private hero, decrypted in the browser: the hero card with its level ring, today and the journal, then
// the wardrobe, boosters, upgrades, arena, team and achievements behind one icon bar. The arena itself is the Mac app's.
import { ChevronsUpIcon, GiftIcon, ListIcon, ShirtIcon, SwordsIcon, TrophyIcon, UsersIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { equipRPG, RPGClient, type RPGItem, type RPGState, RPGUnavailable } from '../../shared'
import { heroGain, heroPose, levelTitle } from '../hero'
import { Loading } from './common'
import { HeroAvatar } from './hero/avatar'
import { Boosters } from './hero/boosters'
import { HeroCard, type ShownGain } from './hero/card'
import { Journal } from './hero/journal'
import { useReducedMotion } from './hero/motion'
import { Achievements, Arena, Team, Upgrades } from './hero/panels'
import { Wardrobe } from './hero/wardrobe'
import { useStore } from './store'
import { Button } from './ui/button'
import { cn } from './ui/cn'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'

export { HeroAvatar }

/**
 * The account's hero, read every five seconds, and `change` to save a transaction. Only a save makes it busy: a
 * background reading never disables a button, and a reading that started before a save never shows the older hero.
 */
export function useHero() {
  const { saved } = useStore()
  const [value, setValue] = useState<{ identity: object; hero: RPGState } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const active = useRef(saved)
  active.current = saved
  const saving = useRef(false)
  const saves = useRef(0)
  useEffect(() => {
    let cancelled = false
    let reading = false
    setError(null)
    setBusy(false)
    saving.current = false
    const refresh = async () => {
      if (!saved || reading || saving.current) return
      reading = true
      const before = saves.current
      try {
        const result = await new RPGClient(`${saved.relay}/api/rpg`, saved.token, saved.key).read()
        if (!cancelled && before === saves.current && !saving.current) {
          setValue({ identity: saved, hero: result.state })
          setError(null)
        }
      } catch (problem) {
        if (!cancelled)
          setError(
            problem instanceof RPGUnavailable
              ? "Tonton's progression needs a newer relay. Sessions keep working meanwhile."
              : 'Could not sync Tonton. Check the connection and relay version.',
          )
      } finally {
        reading = false
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
    if (!saved || saving.current) return null
    saving.current = true
    setBusy(true)
    try {
      const hero = await new RPGClient(`${saved.relay}/api/rpg`, saved.token, saved.key).change(apply)
      saves.current++
      if (active.current !== saved) return null
      setValue({ identity: saved, hero })
      setError(null)
      return hero
    } catch {
      if (active.current === saved) setError('Could not save. Reconnect and retry the same action.')
      return null
    } finally {
      if (active.current === saved) {
        saving.current = false
        setBusy(false)
      }
    }
  }
  return { hero: value?.identity === saved ? value.hero : null, busy, error, change }
}

/** The icon bar under the card, as in the notch; the arena sits apart, on the right. */
const PANELS = [
  { value: 'journal', label: 'Journal', Icon: ListIcon },
  { value: 'wardrobe', label: 'Wardrobe', Icon: ShirtIcon },
  { value: 'boosters', label: 'Boosters', Icon: GiftIcon },
  { value: 'upgrades', label: 'Upgrades', Icon: ChevronsUpIcon },
  { value: 'team', label: 'Team', Icon: UsersIcon },
  { value: 'achievements', label: 'Achievements', Icon: TrophyIcon },
] as const
type Panel = (typeof PANELS)[number]['value'] | 'arena'

/** How long "+XP" floats, and how long the level-up holds the top of the page. */
const GAIN_MS = 1600
const LEVEL_UP_MS = 4000

export function HeroPage() {
  const store = useStore()
  const { hero, busy, error, change } = useHero()
  const [panel, setPanel] = useState<Panel>('journal')
  const [preview, setPreview] = useState<RPGItem | null>(null)
  const { gain, levelUp, endLevelUp } = useLiveGain(hero)
  const now = useNow()
  useEffect(() => {
    if (!preview) return
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreview(null)
    }
    window.addEventListener('keydown', cancel)
    return () => window.removeEventListener('keydown', cancel)
  }, [preview])
  if (!hero) return <main className="flex-1 bg-white p-6">{error ? <p role="alert">{error}</p> : <Loading>Syncing Tonton…</Loading>}</main>
  const statuses = store.state?.sessions.map(session => session.status) ?? []
  const pose = levelUp ? 'cheer' : heroPose(statuses)
  const wear = async (item: RPGItem) => {
    if (!hero.owned.includes(item.id)) return
    const worn = hero.equipped[item.slot] === item.id
    if (await change(h => equipRPG(h, item.slot, worn ? null : item.id))) setPreview(null)
  }
  const pick = (item: RPGItem) => {
    if (preview?.id === item.id) void wear(item)
    else setPreview(item)
  }
  return (
    <main className="flex-1 overflow-y-auto bg-white px-4 py-5 sm:px-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {levelUp && (
          <LevelUp
            level={levelUp}
            equipped={hero.equipped}
            onOpen={() => {
              setPanel('boosters')
              endLevelUp()
            }}
          />
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <HeroCard
          hero={hero}
          pose={pose}
          preview={preview}
          gain={gain}
          now={now}
          busy={busy}
          onWear={() => preview && void wear(preview)}
          onCancelPreview={() => setPreview(null)}
        />
        <Tabs value={panel} onValueChange={value => setPanel(value as Panel)} className="flex flex-col gap-4">
          <TabsList aria-label="Tonton" className="h-auto w-full justify-between gap-1 sm:justify-start">
            {PANELS.map(({ value, label, Icon }) => (
              <TabsTrigger key={value} value={value} aria-label={label} title={label} className="relative h-8 px-2.5">
                <Icon aria-hidden="true" />
                <span className="hidden sm:inline">{label}</span>
                {value === 'boosters' && hero.boosters.length > 0 && (
                  <span
                    className={cn(
                      'absolute -end-1 -top-1 min-w-4 rounded-full bg-primary px-1 text-[10px] font-bold leading-4 text-white',
                      levelUp && 'motion-safe:animate-pulse',
                    )}
                  >
                    {hero.boosters.length}
                  </span>
                )}
              </TabsTrigger>
            ))}
            <TabsTrigger
              value="arena"
              aria-label="Play arena"
              title="Play arena"
              className="h-7 shrink-0 rounded-full border border-primary/30 px-2.5 text-primary sm:ms-auto data-[state=active]:border-foreground"
            >
              <SwordsIcon aria-hidden="true" />
              <span className="hidden sm:inline">Play arena</span>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="journal">
            <Journal hero={hero} now={now} />
          </TabsContent>
          <TabsContent value="wardrobe">
            <Wardrobe hero={hero} preview={preview} onPick={pick} />
          </TabsContent>
          <TabsContent value="boosters">
            <Boosters hero={hero} busy={busy} change={change} />
          </TabsContent>
          <TabsContent value="upgrades">
            <Upgrades hero={hero} busy={busy} change={change} />
          </TabsContent>
          <TabsContent value="arena">
            <Arena hero={hero} />
          </TabsContent>
          <TabsContent value="team">
            <Team />
          </TabsContent>
          <TabsContent value="achievements">
            <Achievements hero={hero} busy={busy} change={change} />
          </TabsContent>
        </Tabs>
      </div>
    </main>
  )
}

/** One short moment across the page, Tonton cheering, then the booster waits behind its icon. */
function LevelUp({ level, equipped, onOpen }: { level: number; equipped: RPGState['equipped']; onOpen: () => void }) {
  const reduced = useReducedMotion()
  return (
    <div role="status" className={cn('flex items-center gap-3 rounded-lg bg-foreground px-4 py-3 text-white', !reduced && 'hero-level-up')}>
      <HeroAvatar equipped={equipped} pose="cheer" moving size={48} label="" />
      <p className="min-w-0 flex-1">
        <strong className="block text-base">
          Level {level} · {levelTitle(level)}
        </strong>
        <span className="text-sm text-white/75">A booster is waiting.</span>
      </p>
      <Button variant="accent" size="sm" onClick={onOpen}>
        Open it
      </Button>
    </div>
  )
}

/** The XP to float and the level reached, from one committed reading of the hero to the next. The first reading is not news. */
function useLiveGain(hero: RPGState | null) {
  const before = useRef<RPGState | null>(null)
  const [gain, setGain] = useState<ShownGain | null>(null)
  const [levelUp, setLevelUp] = useState<number | null>(null)
  useEffect(() => {
    if (!hero) {
      before.current = null
      return
    }
    const next = heroGain(before.current, hero)
    before.current = hero
    if (!next) return
    setGain({ ...next, key: Date.now() })
    if (next.level) setLevelUp(next.level)
  }, [hero])
  useEffect(() => {
    if (!gain) return
    const timer = setTimeout(() => setGain(null), GAIN_MS)
    return () => clearTimeout(timer)
  }, [gain])
  useEffect(() => {
    if (!levelUp) return
    const timer = setTimeout(() => setLevelUp(null), LEVEL_UP_MS)
    return () => clearTimeout(timer)
  }, [levelUp])
  return { gain, levelUp, endLevelUp: () => setLevelUp(null) }
}

/** The clock today's numbers and the journal's times are read against, a minute at a time. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}
