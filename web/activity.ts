// A pool's activity: everything that happened, in order (joins, tasks created and moved, messages, blockers, merges, key
// changes and the other audit events), with a search, filters by member, session and kind, and an export as JSON or
// Markdown. The filters sit in the page's panel, so typing in the search survives the pool's live changes.

import {
  filterTimeline,
  type OpenPool,
  type PoolState,
  sessionName,
  type TimelineFilter,
  timeline,
  timelineJson,
  timelineMarkdown,
} from '../shared'
import { ago } from './control'
import { element } from './markdown'
import type { PageControls, PoolsContext } from './pools'

/** Newest items shown at most; the export has them all. */
const SHOWN = 300

const views = new Map<string, { filter: TimelineFilter; bar?: HTMLElement; problem?: string; who?: string }>()

export function renderActivity(body: HTMLElement, pool: OpenPool, state: PoolState, context: PoolsContext, page: PageControls) {
  const view = views.get(pool.id) ?? { filter: {} }
  views.set(pool.id, view)
  const items = timeline(state)
  // Made again when a member or a session comes or goes, for the filters to list them; not while typing otherwise.
  const who = [...state.members.map(member => member.account), ...state.sessions.map(session => session.session)].join()
  if (!view.bar?.isConnected || view.who !== who) {
    view.who = who
    view.bar = filterBar(view, state, context)
    page.openPanel(view.bar)
  }
  const shown = filterTimeline(items, view.filter)
  const list = element('ol')
  list.className = 'timeline'
  for (const item of shown.slice(-SHOWN).reverse()) {
    const head = element('div', element('strong', item.who), element('span', item.label), element('time', ago(item.at)))
    head.querySelector('time')?.setAttribute('datetime', item.at)
    head.querySelector('time')?.setAttribute('title', new Date(item.at).toLocaleString())
    const lines: HTMLElement[] = [head]
    const about = [
      item.taskTitle ? `Task: ${item.taskTitle}` : item.taskId ? `Task ${item.taskId}` : null,
      item.to ? `To ${item.to}` : null,
    ]
      .filter(Boolean)
      .join(' · ')
    if (about) lines.push(element('small', about))
    if (item.text) lines.push(element('p', item.text))
    const entry = element('li', ...lines)
    entry.dataset.kind = item.kind
    list.append(entry)
  }
  const children: HTMLElement[] = [element('div', element('h2', 'Activity'), element('small', `${shown.length} of ${items.length}`))]
  children[0].className = 'pool-toolbar'
  if (view.problem) {
    const problem = element('p', view.problem)
    problem.className = 'error'
    problem.setAttribute('role', 'alert')
    children.push(problem)
  }
  children.push(shown.length ? list : element('p', items.length ? 'Nothing matches.' : 'Nothing happened yet.'))
  if (shown.length > SHOWN) children.push(element('p', `The ${SHOWN} latest are shown: the export has all ${shown.length}.`))
  body.replaceChildren(...children)
}

function filterBar(view: { filter: TimelineFilter; problem?: string }, state: PoolState, context: PoolsContext): HTMLElement {
  const search = element('input')
  search.type = 'search'
  search.placeholder = 'Search what was said or done'
  search.setAttribute('aria-label', 'Search the activity')
  search.value = view.filter.query ?? ''
  search.oninput = () => {
    view.filter.query = search.value
    context.rerender()
  }
  const choose = (label: string, options: [string, string][], key: 'account' | 'session' | 'kind') => {
    const node = element('select')
    node.setAttribute('aria-label', label)
    for (const [id, text] of [['', label] as [string, string], ...options]) {
      const option = element('option', text)
      option.value = id
      option.selected = id === (view.filter[key] ?? '')
      node.append(option)
    }
    node.onchange = () => {
      view.filter[key] = node.value || undefined
      context.rerender()
    }
    return node
  }
  const members = state.members.map(member => [member.account, member.profile?.name ?? 'A member'] as [string, string])
  const sessions = state.sessions.map(session => [`${session.account}/${session.session}`, sessionName(state, session)] as [string, string])
  const kinds = [...new Set(timeline(state).map(item => item.kind))].sort().map(kind => [kind, kindLabel(state, kind)] as [string, string])
  const download = (format: 'json' | 'md') => {
    const button = element('button', format === 'json' ? 'JSON' : 'Markdown')
    button.title = `Download the activity shown as ${format === 'json' ? 'JSON' : 'Markdown'}`
    button.onclick = () => {
      const items = filterTimeline(timeline(currentState(context, state)), view.filter)
      if (format === 'json') save('pool-activity.json', 'application/json', timelineJson(items))
      else save('pool-activity.md', 'text/markdown', timelineMarkdown(items, poolTitle(state)))
    }
    return button
  }
  const copy = element('button', 'Copy as Markdown')
  copy.onclick = async () => {
    const items = filterTimeline(timeline(currentState(context, state)), view.filter)
    try {
      await navigator.clipboard.writeText(timelineMarkdown(items, poolTitle(state)))
      copy.textContent = 'Copied'
      setTimeout(() => {
        copy.textContent = 'Copy as Markdown'
      }, 1500)
    } catch {
      view.problem = 'This browser did not let the page copy: use the download instead.'
      context.rerender()
    }
  }
  const bar = element(
    'div',
    search,
    choose('Every member', members, 'account'),
    choose('Every session', sessions, 'session'),
    choose('Everything', kinds, 'kind'),
    download('json'),
    download('md'),
    copy,
  )
  bar.className = 'filters'
  return bar
}

/** The state as it is now: the export takes what arrived since the bar was made. */
function currentState(context: PoolsContext, fallback: PoolState): PoolState {
  return context.watch.pool(fallback.id)?.state ?? fallback
}

const poolTitle = (state: PoolState) => `${state.info?.name ?? 'Pool'}: activity`

function kindLabel(state: PoolState, kind: string): string {
  return timeline(state).find(item => item.kind === kind)?.label ?? kind
}

/** A file the browser saves: a link to a blob of the page's own, clicked and let go. No server, nothing leaves the page. */
function save(name: string, type: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = element('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
