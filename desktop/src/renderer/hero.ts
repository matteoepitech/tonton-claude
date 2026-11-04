// Tonton in the island: a thin level ring around the small mascot and the last gain in the closed bar, and his page in
// the open island, with the hero card, today, the journal, the wardrobe, boosters, upgrades and achievements. The same
// view model as the website's (web/hero.ts), drawn with DOM nodes: nothing here is parsed as HTML.

import {
  claimRPGMilestones,
  equipRPG,
  openRPGBooster,
  RPG_CATALOG,
  RPG_RARITIES,
  RPG_SLOTS,
  RPG_UPGRADES,
  type RPGItem,
  type RPGSlot,
  type RPGState,
  randomRPGItem,
  rpgJournal,
  rpgMilestones,
  rpgStats,
  rpgToday,
  upgradeRPG,
} from '../../../shared'
import type { SessionStatus } from '../../../shared/protocol'
import {
  boosterSource,
  currentHour,
  HERO_ART,
  type HeroPixel,
  type HeroPose,
  heroPixels,
  heroPose,
  heroProgress,
  heroRuns,
  hourBars,
  hoursSummary,
  journalLine,
  journalReason,
  journalTime,
  levelTitle,
  MASCOT_SIZE,
  mascotPixels,
  number,
  poseInterval,
  progressText,
  RARITY_COLORS,
  RARITY_LABELS,
  ringSegments,
  SLOT_LABELS,
  streakSquares,
  streakText,
} from '../../../web/hero'
import { element } from '../../../web/markdown'
import type { HeroSync } from './hero-sync'

const SVG = 'http://www.w3.org/2000/svg'
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag)
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value))
  return node
}

function paint(target: SVGSVGElement, pixels: HeroPixel[]) {
  target.replaceChildren(...heroRuns(pixels).map(run => svg('rect', { x: run.x, y: run.y, width: run.width, height: 1, fill: run.color })))
}

function avatar(pixels: HeroPixel[], grid: number, size: number, label: string): SVGSVGElement {
  const node = svg('svg', { viewBox: `0 0 ${grid} ${grid}`, width: size, height: size, 'shape-rendering': 'crispEdges' })
  if (label) {
    node.setAttribute('role', 'img')
    node.setAttribute('aria-label', label)
  } else node.setAttribute('aria-hidden', 'true')
  paint(node, pixels)
  return node
}

/** A level ring of `size`, filled to `fraction`, around `inside`: whole and thin in the bar, in segments on the card. */
function ring(size: number, stroke: number, fraction: number, inside: Node, segmented = false): HTMLElement {
  const radius = size / 2 - stroke / 2 - 1
  const circumference = 2 * Math.PI * radius
  const dashes = segmented
    ? ringSegments(radius, fraction)
    : { track: `${circumference} 0`, fill: `${circumference * fraction} ${circumference}` }
  const circles = svg('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, 'aria-hidden': 'true' })
  const circle = (part: 'track' | 'fill') =>
    svg('circle', {
      cx: size / 2,
      cy: size / 2,
      r: radius,
      fill: 'none',
      class: part,
      'stroke-width': stroke,
      'stroke-dasharray': dashes[part],
      ...(segmented ? {} : { 'stroke-linecap': 'round' }),
    })
  circles.append(circle('track'), circle('fill'))
  const middle = element('span', inside)
  middle.className = 'ring-inside'
  const node = element('span', circles, middle)
  node.className = 'ring'
  node.style.width = node.style.height = `${size}px`
  return node
}

// MARK: The closed bar

/**
 * The ring around the small Tonton, and today's last gain beside it: what was just earned while `fresh` (its XP), the
 * journal's last line otherwise. A click opens his page.
 */
export function compactHero(hero: RPGState, statuses: SessionStatus[], fresh: number | null, onOpen: () => void): HTMLElement[] {
  const progress = heroProgress(hero.xp)
  const mascot = avatar(mascotPixels(hero.equipped, heroPose(statuses), 0), MASCOT_SIZE, 24, '')
  const button = element('button', ring(32, 2.5, progress.fraction, mascot))
  button.className = 'hero-ring'
  button.title = `Tonton · level ${progress.level} · ${progressText(progress)}`
  button.setAttribute('aria-label', button.title)
  button.onclick = event => {
    event.stopPropagation()
    onOpen()
  }
  const last = rpgJournal(hero, 1)[0]
  const today = last && last.day === new Date().toISOString().slice(0, 10) ? last : null
  if (fresh === null && !today) return [button]
  const gain = element('span', `+${number(fresh ?? today?.xp ?? 0)}`)
  gain.className = fresh !== null && !reducedMotion() ? 'gain fresh' : 'gain'
  gain.title = fresh !== null ? `+${number(fresh)} XP` : today ? journalLine(today) : ''
  return [button, gain]
}

// MARK: The page

type Panel = 'journal' | 'wardrobe' | 'boosters' | 'upgrades' | 'achievements'
const PANELS: { value: Panel; label: string }[] = [
  { value: 'journal', label: 'Journal' },
  { value: 'wardrobe', label: 'Wardrobe' },
  { value: 'boosters', label: 'Boosters' },
  { value: 'upgrades', label: 'Upgrades' },
  { value: 'achievements', label: 'Achievements' },
]
const MILESTONES: Record<string, string> = {
  rpgWorker: 'Team player · 10 work rewards',
  rpgVeteran: 'Veteran Tonton · 1,000 XP',
  rpgBoss: 'Boss slayer · first victory',
}
const REVEAL_MS = 1200

export class HeroPage {
  readonly root = element('section')
  private preview: RPGItem | null = null
  private panel: Panel = 'journal'
  private opening: string | null = null
  private revealed = false
  private statuses: SessionStatus[] = []
  private levelUp: number | null = null
  /** Tonton's frames, while the page shows him moving. */
  private timer: ReturnType<typeof setInterval> | undefined
  private revealTimer: ReturnType<typeof setTimeout> | undefined
  /** What the page was last drawn from: sessions change often, and redrawing would take the keyboard focus away. */
  private drawn = ''
  /** On screen: only then does Tonton move, and do late answers draw the page. */
  private visible = false
  private drawnHero: RPGState | null = null

  constructor(
    private readonly sync: HeroSync,
    private readonly onBack: () => void,
  ) {
    this.root.className = 'hero-page'
  }

  /** Escape takes off what is being tried first. */
  cancelPreview(): boolean {
    if (!this.preview) return false
    this.preview = null
    this.render(this.statuses)
    return true
  }

  stop() {
    clearInterval(this.timer)
    clearTimeout(this.revealTimer)
  }

  /** Draws the page again only when what it shows changed: the hero, his pose, a level-up, the sync's state. */
  show(statuses: SessionStatus[], levelUp: number | null) {
    this.visible = true
    const key = [heroPose(statuses), levelUp, this.sync.busy, this.sync.problem, this.sync.unavailable].join('|')
    if (key === this.drawn && this.sync.hero === this.drawnHero) return
    this.render(statuses, levelUp)
  }

  /** Hidden: Tonton stops moving. */
  hide() {
    this.visible = false
    clearInterval(this.timer)
    this.drawn = ''
  }

  render(statuses: SessionStatus[], levelUp: number | null = this.levelUp) {
    this.statuses = statuses
    this.levelUp = levelUp
    if (!this.visible) return
    this.drawn = [heroPose(statuses), levelUp, this.sync.busy, this.sync.problem, this.sync.unavailable].join('|')
    this.drawnHero = this.sync.hero
    clearInterval(this.timer)
    const back = element('button', '‹ Sessions')
    back.dataset.focus = 'back'
    back.className = 'back'
    back.onclick = () => this.onBack()
    const hero = this.sync.hero
    if (!hero) {
      const note = element(
        'p',
        this.sync.unavailable
          ? "Tonton's progression needs a newer relay. Sessions keep working meanwhile."
          : (this.sync.problem ?? 'Syncing Tonton…'),
      )
      note.className = 'note'
      this.root.replaceChildren(back, note)
      return
    }
    const scroll = this.root.querySelector('.hero-scroll')?.scrollTop ?? 0
    const body = element('div', ...this.card(hero, levelUp ? 'cheer' : heroPose(statuses), levelUp))
    body.className = 'hero-scroll'
    if (this.sync.problem) {
      const problem = element('p', this.sync.problem)
      problem.className = 'error'
      body.prepend(problem)
    }
    body.append(this.tabs(hero), this.panelContent(hero))
    const focused = this.focusKey()
    this.root.replaceChildren(back, body)
    body.scrollTop = scroll
    this.refocus(focused)
  }

  /** What has the keyboard in the page, to give it back after a redraw: a redraw replaces every button. */
  private focusKey(): string | undefined {
    const active = document.activeElement
    return active instanceof HTMLElement && this.root.contains(active) ? active.dataset.focus : undefined
  }

  /** The same control again, or the current tab when the control is gone (an opened booster, a bought last rank). */
  private refocus(key: string | undefined) {
    if (!key) return
    const find = (k: string) => this.root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(k)}"]`)
    ;(find(key) ?? find(`tab-${this.panel}`))?.focus({ preventScroll: true })
  }

  /** The notch's card: Tonton in his segmented ring on the left; his title, the next level and today on the right. */
  private card(hero: RPGState, pose: HeroPose, levelUp: number | null): HTMLElement[] {
    const progress = heroProgress(hero.xp)
    const equipped = this.preview ? { ...hero.equipped, [this.preview.slot]: this.preview.id } : hero.equipped
    const big = avatar(heroPixels(equipped, pose, 0), HERO_ART.size, 72, `Tonton, level ${progress.level}`)
    if (!reducedMotion() && this.visible) {
      const ms = poseInterval(pose)
      const frame = () => paint(big, heroPixels(equipped, pose, Math.floor(Date.now() / ms)))
      frame()
      this.timer = setInterval(frame, ms)
    }
    const badge = element('span', String(progress.level))
    badge.className = 'badge'
    badge.title = `Level ${progress.level}`
    const circle = ring(112, 7, progress.fraction, big, true)
    circle.append(badge)
    const parts: HTMLElement[] = []
    if (levelUp) {
      const moment = element(
        'div',
        element('strong', `Level ${levelUp} · ${levelTitle(levelUp)}`),
        element('small', 'A booster is waiting.'),
      )
      moment.className = reducedMotion() ? 'level-up' : 'level-up moving'
      moment.setAttribute('role', 'status')
      parts.push(moment)
    }
    const title = element('span', progress.title)
    title.className = 'title-capsule'
    const next = element('p', progressText(progress))
    next.title = `${number(hero.xp)} XP · ${number(hero.sparks)} sparks`
    const side = element('div', element('div', element('h1', 'Tonton'), title), next, ...this.today(hero))
    side.className = 'side'
    const row = element('div', circle, side)
    row.className = 'row-card'
    const card = element('div', row)
    card.className = 'hero-card'
    if (this.preview) card.append(this.previewBar(hero, this.preview))
    parts.push(card)
    return parts
  }

  private previewBar(hero: RPGState, item: RPGItem): HTMLElement {
    const owned = hero.owned.includes(item.id)
    const worn = hero.equipped[item.slot] === item.id
    const wear = element('button', worn ? 'Take off' : owned ? 'Wear it' : 'Find it in a booster')
    wear.className = 'primary'
    wear.dataset.focus = 'wear'
    wear.disabled = !owned || this.sync.busy
    wear.onclick = () => void this.wear(hero, item)
    const cancel = element('button', 'Cancel')
    cancel.dataset.focus = 'cancel'
    cancel.onclick = () => this.cancelPreview()
    const bar = element(
      'div',
      element('span', `Trying on: ${RARITY_LABELS[item.rarity]} ${SLOT_LABELS[item.slot].toLowerCase()}`),
      wear,
      cancel,
    )
    bar.className = 'preview'
    return bar
  }

  /** Today's XP, the streak with its last seven days, and a bar per hour, the current one in full. */
  private today(hero: RPGState): HTMLElement[] {
    const now = Date.now()
    const today = rpgToday(hero, now)
    const bars = hourBars(today.hours, today.day)
    const peak = Math.max(1, ...bars.map(bar => bar.xp))
    const hour = currentHour(today.day, now)
    const chart = element(
      'div',
      ...bars.map(bar => {
        const column = element('i')
        column.title = `${bar.label} · +${number(bar.xp)} XP`
        column.style.height = bar.xp ? `${Math.max(15, (bar.xp / peak) * 100)}%` : '2px'
        if (bar.xp) column.className = bar.hour === hour ? 'on now' : 'on'
        return column
      }),
    )
    chart.className = 'bars'
    chart.setAttribute('role', 'img')
    chart.setAttribute('aria-label', hoursSummary(bars))
    const days = element(
      'span',
      ...streakSquares(hero, today.streak, now).map(lit => {
        const day = element('i')
        if (lit) day.className = 'lit'
        return day
      }),
    )
    days.className = 'days'
    days.setAttribute('role', 'img')
    days.setAttribute('aria-label', `Last seven days: ${streakText(today.streak)}`)
    const xp = element('strong', `⚡ +${number(today.xp)} XP today`)
    const streak = element('span', today.streak ? `🔥 ${streakText(today.streak)}` : 'No streak yet')
    const line = element('p', xp, streak, days)
    line.className = 'today'
    return [line, chart]
  }

  private journal(hero: RPGState): HTMLElement {
    const entries = rpgJournal(hero, 20)
    if (!entries.length) return element('div', element('p', 'Finish a turn in Claude Code or OpenCode: Tonton earns XP for the work.'))
    const list = element(
      'ol',
      ...entries.map(entry => {
        const xp = element('strong', `+${number(entry.xp)}`)
        return element('li', element('span', xp, ` · ${journalReason(entry)}`), element('small', journalTime(entry)))
      }),
    )
    list.className = 'journal'
    return element('div', list)
  }

  private tabs(hero: RPGState): HTMLElement {
    const bar = element(
      'div',
      ...PANELS.map(({ value, label }) => {
        const count = value === 'boosters' && hero.boosters.length ? ` ${hero.boosters.length}` : ''
        const tab = element('button', label + count)
        tab.dataset.focus = `tab-${value}`
        tab.tabIndex = value === this.panel ? 0 : -1
        tab.setAttribute('role', 'tab')
        tab.setAttribute('aria-selected', String(value === this.panel))
        tab.onclick = () => {
          this.panel = value
          this.render(this.statuses)
        }
        return tab
      }),
    )
    bar.className = 'hero-tabs'
    bar.setAttribute('role', 'tablist')
    bar.setAttribute('aria-label', 'Tonton')
    // Arrow keys move between the tabs, as on the website.
    bar.onkeydown = event => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
      if (!step) return
      event.preventDefault()
      const index = PANELS.findIndex(p => p.value === this.panel)
      this.panel = PANELS[(index + step + PANELS.length) % PANELS.length].value
      this.render(this.statuses)
      this.refocus(`tab-${this.panel}`)
    }
    return bar
  }

  private panelContent(hero: RPGState): HTMLElement {
    const content =
      this.panel === 'journal'
        ? this.journal(hero)
        : this.panel === 'wardrobe'
          ? this.wardrobe(hero)
          : this.panel === 'boosters'
            ? this.boosters(hero)
            : this.panel === 'upgrades'
              ? this.upgrades(hero)
              : this.achievements(hero)
    content.classList.add('hero-panel')
    content.setAttribute('role', 'tabpanel')
    return content
  }

  private wardrobe(hero: RPGState): HTMLElement {
    const rows = RPG_SLOTS.map((slot: RPGSlot) => {
      const tiles = RPG_CATALOG.filter(item => item.slot === slot).map(item => this.tile(hero, item))
      const grid = element('div', ...tiles)
      grid.className = 'tiles'
      return element('div', element('h3', SLOT_LABELS[slot]), grid)
    })
    return element('div', element('p', 'Click a tile to try it on, click it again to wear it.'), ...rows)
  }

  private tile(hero: RPGState, item: RPGItem): HTMLElement {
    const owned = hero.owned.includes(item.id)
    const worn = hero.equipped[item.slot] === item.id
    const picture = avatar(heroPixels({ ...hero.equipped, [item.slot]: item.id }, 'working', 0), HERO_ART.size, 48, '')
    const tile = element('button', picture, element('small', RARITY_LABELS[item.rarity]))
    tile.dataset.focus = `tile-${item.id}`
    tile.className = ['tile', owned ? '' : 'locked', worn ? 'worn' : '', this.preview?.id === item.id ? 'trying' : ''].join(' ').trim()
    tile.style.borderColor = RARITY_COLORS[item.rarity]
    tile.style.borderWidth = `${[1, 2, 2, 3, 3][RPG_RARITIES.indexOf(item.rarity)]}px`
    tile.setAttribute('aria-pressed', String(this.preview?.id === item.id))
    tile.setAttribute(
      'aria-label',
      `${RARITY_LABELS[item.rarity]} ${SLOT_LABELS[item.slot].toLowerCase()}, ${worn ? 'worn' : owned ? 'owned' : 'locked'}`,
    )
    tile.onclick = () => {
      if (this.preview?.id === item.id) void this.wear(hero, item)
      else {
        this.preview = item
        this.render(this.statuses)
      }
    }
    return tile
  }

  private async wear(hero: RPGState, item: RPGItem) {
    if (!hero.owned.includes(item.id)) return
    const worn = hero.equipped[item.slot] === item.id
    if (await this.sync.change(h => equipRPG(h, item.slot, worn ? null : item.id))) this.preview = null
    this.render(this.statuses)
  }

  private boosters(hero: RPGState): HTMLElement {
    const parts: HTMLElement[] = []
    const receipt = this.opening ? hero.openings[this.opening] : undefined
    const drop = RPG_CATALOG.find(item => item.id === receipt?.item)
    if (receipt && drop) {
      const reveal = element('div')
      reveal.className = 'reveal'
      reveal.style.borderColor = RARITY_COLORS[drop.rarity]
      reveal.setAttribute('aria-live', 'polite')
      if (this.revealed) {
        const wear = element('button', hero.equipped[drop.slot] === drop.id ? 'Wearing it' : 'Wear it')
        wear.className = 'primary'
        wear.dataset.focus = 'reveal-wear'
        wear.disabled = this.sync.busy || hero.equipped[drop.slot] === drop.id
        wear.onclick = () => void this.sync.change(h => equipRPG(h, drop.slot, drop.id)).then(() => this.render(this.statuses))
        reveal.append(
          avatar(heroPixels({ ...hero.equipped, [drop.slot]: drop.id }, 'cheer', 0), HERO_ART.size, 96, ''),
          element('strong', `${RARITY_LABELS[drop.rarity]} ${SLOT_LABELS[drop.slot].toLowerCase()}`),
          ...(receipt.duplicateSparks ? [element('small', `Already yours: it became ${receipt.duplicateSparks} sparks.`)] : []),
          wear,
        )
      } else {
        const skip = element('button', 'Skip')
        skip.dataset.focus = 'reveal-wear'
        skip.onclick = () => this.reveal()
        reveal.append(element('p', 'Opening…'), skip)
      }
      parts.push(reveal)
    }
    const waiting = hero.boosters.map(id => {
      const open = element('button', 'Open')
      open.dataset.focus = `open-${id}`
      open.className = 'primary'
      open.disabled = this.sync.busy
      open.onclick = async () => {
        // Drawn once, before the transaction: a retried save keeps the same item.
        const candidate = randomRPGItem()
        if (await this.sync.change(h => openRPGBooster(h, id, candidate.id))) {
          this.opening = id
          this.revealed = reducedMotion()
          clearTimeout(this.revealTimer)
          this.revealTimer = setTimeout(() => this.reveal(), REVEAL_MS)
        }
        this.render(this.statuses)
      }
      const row = element('div', element('span', boosterSource(id)), open)
      row.className = 'row'
      return row
    })
    parts.push(
      ...(waiting.length ? waiting : [element('p', 'No booster waiting. Each level brings one, and so do bosses and achievements.')]),
    )
    return element('div', ...parts)
  }

  private reveal() {
    this.revealed = true
    this.render(this.statuses)
  }

  private upgrades(hero: RPGState): HTMLElement {
    const stats = rpgStats(hero)
    const steps = { health: 15, attack: 3, movement: 6 }
    const rows = RPG_UPGRADES.map(stat => {
      const rank = hero.upgrades[stat] ?? 0
      const cost = (rank + 1) * 10
      const buy = element('button', rank === 10 ? 'Highest rank' : `Upgrade · ${cost} sparks`)
      buy.dataset.focus = `upgrade-${stat}`
      buy.disabled = this.sync.busy || rank === 10 || hero.sparks < cost
      buy.onclick = () => void this.sync.change(h => upgradeRPG(h, stat, rank + 1)).then(() => this.render(this.statuses))
      const name = `${stat[0].toUpperCase()}${stat.slice(1)} ${stats[stat]}${rank < 10 ? ` → ${stats[stat] + steps[stat]}` : ''}`
      const row = element('div', element('span', name, element('small', ` · rank ${rank}/10`)), buy)
      row.className = 'row'
      return row
    })
    const note = element('p', `Sparks buy permanent ranks for the arena, played in the Mac app. You have ${number(hero.sparks)} sparks.`)
    return element('div', note, ...rows)
  }

  private achievements(hero: RPGState): HTMLElement {
    const rows = rpgMilestones(hero).map(m => {
      const bar = element('progress')
      bar.max = m.target
      bar.value = Math.min(m.done, m.target)
      bar.setAttribute('aria-label', MILESTONES[m.id] ?? m.id)
      return element('div', element('span', MILESTONES[m.id] ?? m.id), bar)
    })
    const claimable = claimRPGMilestones(hero) !== hero
    const claim = element('button', claimable ? 'Claim achievement boosters' : 'Nothing to claim')
    claim.dataset.focus = 'claim'
    claim.disabled = this.sync.busy || !claimable
    claim.onclick = () => void this.sync.change(claimRPGMilestones).then(() => this.render(this.statuses))
    return element('div', ...rows, claim)
  }
}
