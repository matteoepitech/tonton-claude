// The clusters in the Windows and Linux island (desktop/): a compact strip above the sessions with each cluster's clock,
// who is working and the last posts, and a cluster's page in the island's window: the roster, your sessions with Put in
// and Take out, the feed and the claims. Built from the same model as the website's Clusters page (site/clusters/model.ts).
// One of your sessions set to live that gets digests, as it skips permission prompts, says so, with Live anyway.

import type { ClusterState, ListedCluster, OpenCluster, Session } from '../shared'
import { STATUS_LABELS } from '../shared'
import { element } from './markdown'
import {
  authorLabel,
  clockView,
  DELIVERIES,
  type DeliveryOption,
  eventLine,
  heldClaims,
  POST_KINDS,
  rememberedDelivery,
  roster,
  sessionName,
  TOOL_LABELS,
  TURNED_DIGEST,
  turnsDigest,
} from './site/clusters/model'
import { dot } from './views'

export interface ClusterStripItem {
  listed: ListedCluster
  open: OpenCluster | null
}

/** What the island does when the person acts on a cluster. */
export interface ClusterActions {
  open(clusterId: string): void
  join(invite: string, name: string): Promise<string | null>
}

const LAST_POSTS = 2

/** Each cluster in a few lines: its name and clock, who is working, and the last posts. Nothing when there is none. */
export function renderClusterStrip(strip: HTMLElement, items: ClusterStripItem[], actions: ClusterActions, problem: string | null) {
  const children: HTMLElement[] = []
  const header = element('h2', 'Clusters')
  const join = element('button', 'Join')
  join.className = 'link'
  join.title = 'Join a cluster with an invite'
  header.append(join)
  children.push(header)
  const form = joinForm(actions, () => form.remove())
  join.onclick = () => (strip.contains(form) ? form.remove() : header.after(form))
  for (const { listed, open } of items) {
    const state = open?.state ?? null
    const clock = clockView(open?.clock ?? null)
    const card = element('button')
    card.className = 'cluster'
    card.onclick = () => actions.open(listed.summary.id)
    const title = element('span', element('strong', listed.info?.name ?? 'A cluster'))
    title.className = 'cluster-title'
    if (clock.label) {
      const left = element('small', clock.label)
      left.className = clock.lastHour || clock.ended ? 'clock urgent' : 'clock'
      title.append(left)
    }
    card.append(title)
    if (state) {
      const busy = state.sessions.filter(s => s.online && (s.status === 'working' || s.status === 'permission' || s.status === 'waiting'))
      const who = element('small', `${busy.length} working of ${state.sessions.length} · ${state.members.length} members`)
      card.append(who)
      for (const post of state.posts.slice(-LAST_POSTS).reverse()) {
        const line = element('small', `${authorLabel(state, post).split(' · ')[0]}: ${post.body?.text || eventLine(post) || ''}`)
        line.className = 'post'
        card.append(line)
      }
    }
    children.push(card)
  }
  if (problem) {
    const error = element('p', problem)
    error.className = 'error'
    children.push(error)
  }
  strip.replaceChildren(...children)
}

function joinForm(actions: ClusterActions, done: () => void): HTMLElement {
  const invite = element('textarea')
  invite.placeholder = 'The invite link someone sent you'
  invite.spellcheck = false
  const name = element('input')
  name.placeholder = 'Your name in the cluster'
  const submit = element('button', 'Join the cluster')
  submit.className = 'primary'
  submit.onclick = async () => {
    submit.disabled = true
    const id = await actions.join(invite.value, name.value.trim())
    submit.disabled = false
    if (id) done()
  }
  const form = element('div', invite, name, submit)
  form.className = 'cluster-join'
  return form
}

/** What a cluster's page can do for this account's own sessions: only their owner puts them in or takes them out. */
export interface ClusterPageActions {
  back(): void
  putIn(session: Session, delivery: DeliveryOption): void
  takeOut(sessionId: string): void
}

/** A cluster in the island's window: the clock, the roster, your sessions, the feed and the claims. */
export function renderClusterPage(
  page: HTMLElement,
  cluster: OpenCluster,
  state: ClusterState,
  account: string | null,
  own: Session[],
  actions: ClusterPageActions,
) {
  const back = element('button', '‹')
  back.className = 'back'
  back.title = 'Back to the sessions'
  back.onclick = () => actions.back()
  const clock = clockView(cluster.clock)
  const header = element('div', back, element('strong', state.info?.name ?? 'A cluster'))
  header.className = 'chat-header'
  if (clock.label) header.append(element('small', clock.next ? `${clock.label} · next: ${clock.next.name}` : clock.label))
  const body = element('div')
  body.className = 'messages cluster-page'

  for (const member of roster(state, account)) {
    body.append(element('h2', member.mine ? `${member.name} (you)` : member.name))
    if (!member.sessions) body.append(element('p', 'No session in the cluster yet.'))
    for (const machine of member.machines)
      for (const session of machine.sessions) {
        const profile = session.profile
        const facts = [machine.name, profile?.project, profile?.branch, profile?.tool ? TOOL_LABELS[profile.tool] : undefined]
        const text = element(
          'span',
          element('strong', sessionName(session)),
          element(
            'small',
            profile?.status ?? (!session.ready ? 'Waiting for its agent' : session.status ? STATUS_LABELS[session.status] : ''),
          ),
          element('small', facts.filter(Boolean).join(' · ')),
        )
        const row = element('div', dot(session.online ? (session.status ?? 'idle') : 'offline'), text)
        row.className = 'session'
        // As this window last chose it: the relay sends a session's order only to its agent.
        const yours = member.mine ? own.find(s => s.id === session.session) : undefined
        if (yours && turnsDigest(rememberedDelivery(state.id, session.session), session)) {
          const turned = element('small', `⚠ ${TURNED_DIGEST}`)
          turned.className = 'turned-digest'
          text.append(turned)
          const anyway = element('button', 'Live anyway')
          anyway.title = 'Posts reach it as they come, though it skips permission prompts'
          anyway.onclick = () => actions.putIn(yours, 'anyway')
          row.append(anyway)
        }
        if (member.mine) {
          const out = element('button', 'Take out')
          out.onclick = () => actions.takeOut(session.session)
          row.append(out)
        }
        body.append(row)
      }
  }

  const inside = new Set(state.sessions.filter(s => s.account === account).map(s => s.session))
  const outside = own.filter(s => s.agentOnline && s.status !== 'ended' && !inside.has(s.id))
  if (outside.length) {
    body.append(element('h2', 'Put your sessions in'))
    for (const session of outside) {
      const delivery = element('select')
      delivery.setAttribute('aria-label', 'How it takes the posts')
      for (const choice of DELIVERIES) {
        const option = element('option', choice.label)
        option.value = choice.value
        option.title = choice.detail
        delivery.append(option)
      }
      delivery.value = rememberedDelivery(state.id, session.id)
      const put = element('button', 'Put in')
      put.onclick = () => actions.putIn(session, delivery.value as DeliveryOption)
      const row = element(
        'div',
        dot(session.status),
        element('span', element('strong', session.name ?? session.project), element('small', session.machine)),
        delivery,
        put,
      )
      row.className = 'session'
      body.append(row)
    }
  }

  const claims = heldClaims(cluster.claims?.claims ?? [])
  if (claims.length) {
    body.append(element('h2', 'Claims'))
    for (const claim of claims)
      body.append(
        element(
          'p',
          element('code', claim.paths.join(', ')),
          ` · ${authorLabel(state, { account: claim.account, session: claim.session })}`,
        ),
      )
  }

  body.append(element('h2', 'Feed'))
  if (!state.posts.length) body.append(element('p', 'Nothing posted yet.'))
  for (const post of [...state.posts].reverse().slice(0, 50)) {
    const line = element(
      'div',
      element('small', `${post.body ? POST_KINDS[post.body.kind] : 'Sealed'} · ${authorLabel(state, post)}`),
      element('p', post.body ? post.body.text || eventLine(post) || '' : 'This post does not open with the keys you hold.'),
    )
    line.className = 'cluster-post'
    body.append(line)
  }
  page.replaceChildren(header, body)
}
