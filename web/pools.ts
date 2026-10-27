// The pools of the account on the relay's website: the list, a new pool, joining with an invite, and a pool's page with
// its tabs (tasks, members, invites, settings). Everything a pool says is opened in this page with keys the relay never
// gets (shared/pool-watch.ts). A tab is a name and a function that fills the page's body: more go in `POOL_TABS`.

import {
  assignableRoles,
  canKick,
  type InviteSummary,
  invitableRoles,
  type ListedPool,
  memberName,
  type OpenPool,
  type PoolRole,
  type PoolState,
  type PoolWatch,
  poolAbilities,
  qrCode,
  sessionName,
  sortedMembers,
} from '../shared'
import { element } from './markdown'
import { renderBoard } from './tasks'

export interface PoolsContext {
  watch: PoolWatch
  account: string
  rerender(): void
}

/** What the main part shows: a pool, the form for a new pool, the one to join, or nothing yet. */
type View = { kind: 'pool'; id: string } | { kind: 'new' } | { kind: 'join' } | null

let view: View = null
let tab = 'tasks'

export interface PoolTab {
  id: string
  label: string
  /** Shown to these roles only; every role when missing. */
  roles?: PoolRole[]
  render(body: HTMLElement, pool: OpenPool, state: PoolState, context: PoolsContext, page: PageControls): void
}

export interface PageControls {
  /** A form in the panel above the body: live changes redraw the body, never the panel. */
  openPanel(panel: HTMLElement | null): void
}

export const POOL_TABS: PoolTab[] = [
  {
    id: 'tasks',
    label: 'Tasks',
    render: (body, pool, state, context, page) =>
      renderBoard(body, {
        pool,
        state,
        openPanel: page.openPanel,
        save: async (id, task) => (await context.watch.saveTask(pool.id, id, task)) !== null,
      }),
  },
  { id: 'members', label: 'Members', render: renderMembers },
  { id: 'invites', label: 'Invites', roles: ['owner', 'admin'], render: renderInvites },
  { id: 'settings', label: 'Settings', render: renderSettings },
]

/** True when the list shows nothing selected: on phones, the list then takes the screen. */
export const poolSelected = () => view !== null

// MARK: The list

export function renderPoolList(nav: HTMLElement, context: PoolsContext) {
  const { watch } = context
  const create = element('button', 'New pool')
  create.className = 'primary'
  create.onclick = () => go({ kind: 'new' }, context)
  const join = element('button', 'Join')
  join.title = 'Join a pool with an invite'
  join.onclick = () => go({ kind: 'join' }, context)
  const actions = element('div', create, join)
  actions.className = 'pool-actions'
  const children: HTMLElement[] = [actions, element('h2', 'Pools')]
  if (!watch.pools.length) children.push(element('p', 'No pools yet. Make one, or join with an invite from a teammate.'))
  for (const listed of watch.pools) children.push(poolRow(listed, context))
  if (watch.problem) {
    const problem = element('p', watch.problem)
    problem.className = 'pool-error'
    problem.setAttribute('role', 'alert')
    children.push(problem)
  }
  nav.replaceChildren(...children)
}

function poolRow(listed: ListedPool, context: PoolsContext): HTMLElement {
  const { summary, info } = listed
  const row = element(
    'button',
    element(
      'span',
      element('strong', info?.name ?? 'A pool'),
      element(
        'small',
        `${roleLabel(summary.role)} · ${summary.members} member${summary.members === 1 ? '' : 's'}${summary.paused ? ' · paused' : ''}`,
      ),
    ),
  )
  row.className = 'session'
  if (view?.kind === 'pool' && view.id === summary.id) row.classList.add('selected')
  row.onclick = () => go({ kind: 'pool', id: summary.id }, context)
  return row
}

function go(next: View, context: PoolsContext) {
  if (view?.kind === 'pool' && (next?.kind !== 'pool' || next.id !== view.id)) context.watch.close(view.id)
  view = next
  page = null
  if (next?.kind === 'pool') {
    tab = 'tasks'
    context.watch.open(next.id)
  }
  context.rerender()
}

// MARK: The main part

/** The page is built once per pool and tab: its panel keeps what is being typed while the pool changes live. */
let page: { key: string; root: HTMLElement; header: HTMLElement; tabs: HTMLElement; panel: HTMLElement; body: HTMLElement } | null = null

export function renderPoolMain(main: HTMLElement, context: PoolsContext, onBack: () => void) {
  if (!view) {
    main.replaceChildren(element('p', 'Pick a pool, or make one.'))
    page = null
    return
  }
  const key = view.kind === 'pool' ? `${view.id}:${tab}` : view.kind
  if (page?.key !== key || !main.contains(page.root)) {
    const header = element('div')
    header.className = 'chat-header'
    const tabs = element('div')
    tabs.className = 'pool-tabs'
    tabs.setAttribute('role', 'tablist')
    const panel = element('div')
    panel.className = 'pool-panel'
    const body = element('div')
    body.className = 'pool-body'
    const root = element('div', header, tabs, panel, body)
    root.className = 'pool-page'
    page = { key, root, header, tabs, panel, body }
    main.replaceChildren(root)
    if (view.kind === 'new') panel.append(newPoolForm(context))
    if (view.kind === 'join') panel.append(joinForm(context))
  }
  const back = element('button', '‹ Pools')
  back.className = 'back'
  back.onclick = () => {
    if (view?.kind === 'pool') context.watch.close(view.id)
    view = null
    page = null
    onBack()
  }
  if (view.kind !== 'pool') {
    page.header.replaceChildren(back, element('strong', view.kind === 'new' ? 'New pool' : 'Join a pool'))
    page.tabs.replaceChildren()
    page.body.replaceChildren()
    return
  }
  const poolId = view.id
  const pool = context.watch.pool(poolId)
  const state = pool?.state
  const name = state?.info?.name ?? context.watch.pools.find(listed => listed.summary.id === poolId)?.info?.name ?? 'A pool'
  page.header.replaceChildren(
    back,
    element(
      'span',
      element('strong', name),
      element(
        'small',
        [state?.info?.goal, pool ? roleLabel(pool.role) : null, state?.paused ? 'Paused' : null].filter(Boolean).join(' · '),
      ),
    ),
  )
  if (!pool || !state) {
    page.tabs.replaceChildren()
    page.body.replaceChildren(element('p', pool?.problem ?? 'Opening the pool…'))
    return
  }
  const visible = POOL_TABS.filter(item => !item.roles || item.roles.includes(pool.role))
  page.tabs.replaceChildren(
    ...visible.map(item => {
      const button = element('button', item.label)
      button.setAttribute('role', 'tab')
      button.setAttribute('aria-selected', String(item.id === tab))
      button.onclick = () => {
        tab = item.id
        page = null
        context.rerender()
      }
      return button
    }),
  )
  const controls: PageControls = {
    openPanel: panel => {
      page?.panel.replaceChildren(...(panel ? [panel] : []))
      panel?.querySelector<HTMLElement>('input, textarea, select')?.focus()
    },
  }
  const children: HTMLElement[] = []
  if (pool.problem) {
    const problem = element('p', pool.problem)
    problem.className = 'error'
    problem.setAttribute('role', 'alert')
    const dismiss = element('button', 'OK')
    dismiss.onclick = () => context.watch.clearProblem(pool.id)
    children.push(element('div', problem, dismiss))
  }
  const body = element('div')
  ;(visible.find(item => item.id === tab) ?? visible[0]).render(body, pool, state, context, controls)
  page.body.replaceChildren(...children, body)
}

function newPoolForm(context: PoolsContext): HTMLElement {
  const name = element('input')
  name.placeholder = 'Basel Hack'
  name.required = true
  const goal = element('textarea')
  goal.placeholder = 'What the pool builds: the app, its stack, the deadline'
  goal.rows = 3
  const you = element('input')
  you.placeholder = 'Your name in the pool'
  const create = element('button', 'Create')
  create.className = 'primary'
  const form = element(
    'form',
    element('label', element('span', 'Name'), name),
    element('label', element('span', 'Goal'), goal),
    element('label', element('span', 'You'), you),
    element('p', 'The pool gets its own key, made in this browser. The relay only keeps it sealed with your account key.'),
    element('div', create),
  )
  form.className = 'pool-form'
  form.onsubmit = async event => {
    event.preventDefault()
    if (!name.value.trim()) return
    create.disabled = true
    const id = await context.watch.create(
      { name: name.value.trim(), ...(goal.value.trim() ? { goal: goal.value.trim() } : {}) },
      you.value.trim() ? { name: you.value.trim() } : undefined,
    )
    create.disabled = false
    if (id) go({ kind: 'pool', id }, context)
  }
  return form
}

function joinForm(context: PoolsContext): HTMLElement {
  const invite = element('textarea')
  invite.placeholder = 'tontonpool1.…'
  invite.spellcheck = false
  invite.rows = 4
  const you = element('input')
  you.placeholder = 'Your name in the pool'
  const join = element('button', 'Join')
  join.className = 'primary'
  const form = element(
    'form',
    element('label', element('span', 'Invite'), invite),
    element('label', element('span', 'You'), you),
    element('p', 'Whoever sent it sees you join. The invite holds the pool key: it stays in this browser.'),
    element('div', join),
  )
  form.className = 'pool-form'
  form.onsubmit = async event => {
    event.preventDefault()
    join.disabled = true
    const id = await context.watch.join(invite.value, you.value.trim() ? { name: you.value.trim() } : undefined)
    join.disabled = false
    if (id) go({ kind: 'pool', id }, context)
  }
  return form
}

// MARK: Members

function renderMembers(body: HTMLElement, pool: OpenPool, state: PoolState, context: PoolsContext, page: PageControls) {
  const { watch, account } = context
  const me = state.members.find(member => member.account === account)
  const rename = element('button', 'Your name')
  rename.onclick = () => page.openPanel(profileForm(context, pool, me?.profile?.name ?? ''))
  const rows = sortedMembers(state).map(member => {
    const self = member.account === account
    const cells: (string | HTMLElement)[] = [
      element(
        'span',
        element('strong', memberName(state, member.account) + (self ? ' (you)' : '')),
        element('small', `Joined ${new Date(member.joinedAt).toLocaleDateString()}`),
      ),
    ]
    const roles = assignableRoles(pool.role, member.role, self)
    if (roles.length) {
      const select = element('select')
      select.setAttribute('aria-label', `Role of ${memberName(state, member.account)}`)
      for (const role of [member.role, ...roles.filter(role => role !== member.role)]) {
        const option = element('option', roleLabel(role))
        option.value = role
        select.append(option)
      }
      select.onchange = () => void watch.setRole(pool.id, member.account, select.value as Exclude<PoolRole, 'owner'>)
      cells.push(select)
    } else cells.push(element('em', roleLabel(member.role)))
    if (pool.role === 'owner' && !self) {
      const hand = element('button', 'Make owner')
      hand.onclick = () => {
        if (confirm(`Hand the pool to ${memberName(state, member.account)}? You stay as an admin.`))
          void watch.transferOwnership(pool.id, member.account)
      }
      cells.push(hand)
    }
    if (canKick(pool.role, member.role, self)) {
      const kick = element('button', 'Remove')
      kick.className = 'danger'
      kick.onclick = async () => {
        if (!confirm(`Remove ${memberName(state, member.account)}? The pool gets a new key, which they never receive.`)) return
        const skipped = await watch.kick(pool.id, member.account)
        if (skipped?.length)
          alert(`${skipped.length} member${skipped.length === 1 ? '' : 's'} could not get the new key: send them a new invite.`)
      }
      cells.push(kick)
    }
    const row = element('div', ...cells)
    row.className = 'member'
    return row
  })
  const sessions = state.sessions.map(session => {
    const profile = session.profile
    const what = [
      profile?.tool === 'opencode' ? 'OpenCode' : profile?.tool === 'claude' ? 'Claude Code' : null,
      profile?.machine,
      profile?.skills,
    ]
    const status = !session.online ? 'offline' : session.ready ? 'ready' : 'joining'
    const row = element(
      'div',
      element('span', element('strong', sessionName(state, session)), element('small', what.filter(Boolean).join(' · '))),
      element('em', status),
    )
    row.className = 'member'
    if (profile?.orchestrator) row.classList.add('orchestrator')
    return row
  })
  body.replaceChildren(
    element('div', element('h2', 'Members'), rename),
    ...rows,
    element('h2', 'Sessions'),
    ...(sessions.length ? sessions : [element('p', 'No session works for the pool yet. Members put theirs in from the notch.')]),
  )
  body.firstElementChild?.classList.add('pool-toolbar')
}

function profileForm(context: PoolsContext, pool: OpenPool, current: string): HTMLElement {
  const name = element('input')
  name.value = current
  name.placeholder = 'Your name in the pool'
  const save = element('button', 'Save')
  save.className = 'primary'
  const cancel = element('button', 'Close')
  cancel.type = 'button'
  const form = element('form', element('label', element('span', 'Your name'), name), element('div', cancel, save))
  form.className = 'pool-form'
  cancel.onclick = () => form.remove()
  form.onsubmit = async event => {
    event.preventDefault()
    if (name.value.trim() && (await context.watch.updateProfile(pool.id, { name: name.value.trim() }))) form.remove()
  }
  return form
}

// MARK: Invites

/** The invites listed for each pool, fetched when the tab opens and after each change. */
const invitesOf = new Map<string, InviteSummary[]>()

function renderInvites(body: HTMLElement, pool: OpenPool, state: PoolState, context: PoolsContext, page: PageControls) {
  const { watch } = context
  const listed = invitesOf.get(pool.id)
  if (!listed)
    void watch.invites(pool.id).then(found => {
      invitesOf.set(pool.id, found ?? [])
      context.rerender()
    })
  const add = element('button', 'New invite')
  add.className = 'primary'
  add.onclick = () => page.openPanel(inviteForm(context, pool, page))
  const rows = (listed ?? []).map(invite => {
    const revoke = element('button', 'Revoke')
    revoke.onclick = async () => {
      if (await watch.revokeInvite(pool.id, invite.id)) {
        invitesOf.delete(pool.id)
        context.rerender()
      }
    }
    const row = element(
      'div',
      element(
        'span',
        element('strong', `${roleLabel(invite.role)} · ${invite.usesLeft} use${invite.usesLeft === 1 ? '' : 's'} left`),
        element('small', `Until ${new Date(invite.expiresAt).toLocaleString()}`),
      ),
      revoke,
    )
    row.className = 'member'
    return row
  })
  const toolbar = element('div', element('h2', 'Invites'), add)
  toolbar.className = 'pool-toolbar'
  body.replaceChildren(
    toolbar,
    ...(listed === undefined ? [element('p', 'Loading the invites…')] : rows.length ? rows : [element('p', 'No open invite.')]),
    element(
      'p',
      `Removing a member gives the pool a new key and revokes every open invite. ${state.members.length} member${state.members.length === 1 ? '' : 's'} now.`,
    ),
  )
}

function inviteForm(context: PoolsContext, pool: OpenPool, page: PageControls): HTMLElement {
  const choice = <T extends string | number>(label: string, values: [T, string][], selected: T) => {
    const select = element('select')
    for (const [value, text] of values) {
      const option = element('option', text)
      option.value = String(value)
      option.selected = value === selected
      select.append(option)
    }
    return { select, row: element('label', element('span', label), select) }
  }
  const uses = choice(
    'Uses',
    [
      [1, 'Once'],
      [5, '5 times'],
      [20, '20 times'],
      [100, '100 times'],
    ],
    1,
  )
  const hours = choice(
    'Valid for',
    [
      [1, '1 hour'],
      [24, '1 day'],
      [168, '1 week'],
      [720, '30 days'],
    ],
    24,
  )
  const role = choice(
    'Joins as',
    invitableRoles(pool.role).map(value => [value, roleLabel(value)] as [string, string]),
    'member',
  )
  const create = element('button', 'Create the invite')
  create.className = 'primary'
  const close = element('button', 'Close')
  close.type = 'button'
  close.onclick = () => page.openPanel(null)
  const result = element('div')
  const form = element(
    'form',
    element('h3', 'New invite'),
    uses.row,
    hours.row,
    role.row,
    element('p', 'The invite holds the pool key: send it to people you trust, and revoke it once they joined.'),
    element('div', close, create),
    result,
  )
  form.className = 'pool-form'
  form.onsubmit = async event => {
    event.preventDefault()
    create.disabled = true
    const made = await context.watch.invite(pool.id, {
      uses: Number(uses.select.value),
      hours: Number(hours.select.value),
      role: role.select.value as Exclude<PoolRole, 'owner'>,
    })
    create.disabled = false
    if (!made) return
    invitesOf.delete(pool.id)
    result.replaceChildren(...inviteResult(made.link))
    context.rerender()
  }
  return form
}

function inviteResult(link: string): HTMLElement[] {
  const field = element('textarea')
  field.value = link
  field.readOnly = true
  field.rows = 3
  field.spellcheck = false
  const copy = element('button', 'Copy')
  copy.type = 'button'
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(link)
      copy.textContent = 'Copied'
    } catch {
      field.select()
    }
  }
  const children: HTMLElement[] = [field, element('div', copy)]
  const canvas = qrCanvas(link)
  if (canvas) children.push(canvas, element('p', 'Scan it from the web app on a phone, or paste the link in Join.'))
  return children
}

/** The invite as a QR code: dark on white whatever the theme, with its quiet zone, as scanners expect. */
function qrCanvas(text: string): HTMLCanvasElement | null {
  const code = qrCode(text)
  if (!code) return null
  const scale = 4
  const side = (code.size + 8) * scale
  const canvas = element('canvas')
  canvas.width = side
  canvas.height = side
  canvas.className = 'qr'
  canvas.setAttribute('role', 'img')
  canvas.setAttribute('aria-label', 'QR code of the invite')
  const context = canvas.getContext('2d')
  if (!context) return null
  context.fillStyle = '#fff'
  context.fillRect(0, 0, side, side)
  context.fillStyle = '#000'
  code.modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) context.fillRect((x + 4) * scale, (y + 4) * scale, scale, scale)
    })
  })
  return canvas
}

// MARK: Settings

function renderSettings(body: HTMLElement, pool: OpenPool, state: PoolState, context: PoolsContext, page: PageControls) {
  const { watch } = context
  const can = poolAbilities(pool.role)
  const children: HTMLElement[] = [element('h2', 'Settings')]
  if (can.editInfo) {
    const edit = element('button', 'Change the name and goal')
    edit.onclick = () => page.openPanel(infoForm(context, pool, state))
    children.push(element('div', edit))
  }
  children.push(
    element(
      'p',
      `Key version ${state.keyVersion}. Created ${new Date(state.createdAt).toLocaleDateString()}. Everything the pool says is sealed with its key; the relay sees ids, roles, sizes and times.`,
    ),
  )
  if (can.leave) {
    const leave = element('button', 'Leave the pool')
    leave.className = 'danger'
    leave.onclick = () => {
      if (confirm('Leave the pool? Your sessions leave it with you.')) void watch.leave(pool.id).then(() => go(null, context))
    }
    children.push(element('div', leave))
  }
  if (can.remove) {
    const remove = element('button', 'Delete the pool')
    remove.className = 'danger'
    remove.onclick = () => {
      if (confirm('Delete the pool for everyone? Its tasks, notes and messages go with it.'))
        void watch.remove(pool.id).then(() => go(null, context))
    }
    children.push(element('div', remove))
  }
  body.replaceChildren(...children)
}

function infoForm(context: PoolsContext, pool: OpenPool, state: PoolState): HTMLElement {
  const name = element('input')
  name.value = state.info?.name ?? ''
  const goal = element('textarea')
  goal.value = state.info?.goal ?? ''
  goal.rows = 3
  const save = element('button', 'Save')
  save.className = 'primary'
  const close = element('button', 'Close')
  close.type = 'button'
  const form = element(
    'form',
    element('label', element('span', 'Name'), name),
    element('label', element('span', 'Goal'), goal),
    element('div', close, save),
  )
  form.className = 'pool-form'
  close.onclick = () => form.remove()
  form.onsubmit = async event => {
    event.preventDefault()
    if (!name.value.trim()) return
    if (await context.watch.updateInfo(pool.id, { name: name.value.trim(), ...(goal.value.trim() ? { goal: goal.value.trim() } : {}) }))
      form.remove()
  }
  return form
}

const ROLE_LABELS: Record<PoolRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' }
const roleLabel = (role: PoolRole) => ROLE_LABELS[role]
