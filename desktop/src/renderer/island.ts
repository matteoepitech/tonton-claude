// The island: a black pill at the top of the screen that says what the sessions are doing, and opens on their list, a
// conversation and its permission requests. It renders the web app's views (web/views.ts) on the client core (shared/).
// The main process puts the relay token on this page's socket, so the page only holds the end-to-end key, as a CryptoKey
// it cannot read back.

import {
  appSocketUrl,
  type ClientState,
  importAccountKey,
  isLive,
  liveActivity,
  liveActivityText,
  mostUrgent,
  needsAttention,
  RelayClient,
  type Session,
  type SocketLike,
  STATUS_LABELS,
  sessionAlert,
  Vault,
} from '../../../shared'
import { element } from '../../../web/markdown'
import { dot, renderChat, renderList } from '../../../web/views'
import { DEFAULT_RELAY, type IslandAccount, type IslandBridge, type IslandMode } from '../bridge'

declare global {
  interface Window {
    tonton: IslandBridge
  }
}

/** How long the closed island shows a session that starts needing the user, or finishes. */
const PEEK_MS = 6000
/** The window loses focus for a moment when a dialog or the menu opens: only a real switch to another app closes it. */
const BLUR_GRACE_MS = 150

const bridge = window.tonton
const app = document.getElementById('app') as HTMLElement
const bar = element('div')
const panel = element('div')

let mode: IslandMode = 'collapsed'
let client: RelayClient | null = null
let state: ClientState | null = null
let host = ''
/** The list or one conversation: the island is as narrow as a phone. */
let showingChat = false
/** The last version of each session, to tell what changed in the next one. */
let known = new Map<string, Session>()
let peek: Session | null = null
let peekTimer: ReturnType<typeof setTimeout> | undefined
/** Shown above the list once, after creating an account. */
let notice: string | null = null
const parts: { list?: HTMLElement; chat?: HTMLElement; shell?: HTMLElement } = {}

async function start() {
  // Always dark, like the notch.
  document.documentElement.dataset.theme = 'dark'
  app.className = 'island'
  bar.className = 'bar'
  bar.onclick = () => (mode === 'collapsed' ? expand() : collapse())
  panel.className = 'panel'
  app.replaceChildren(bar, panel)
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && mode === 'expanded') collapse()
  })
  bridge.onCommand(command => {
    if (command === 'expand') expand()
    else if (command === 'collapse') collapse()
    else if (command === 'blur') setTimeout(closeUnlessFocused, BLUR_GRACE_MS)
    else void signOut(null, false)
  })
  const account = await bridge.account()
  if (account) void connect(account)
  else void signInScreen()
}

function expand() {
  if (mode === 'expanded') return
  mode = 'expanded'
  endPeek()
  // Straight to the session that waits for the user, like clicking the notch's banner.
  const urgent = state ? liveActivity(state.sessions) : null
  if (urgent && needsAttention(urgent.status)) {
    showingChat = true
    client?.select(urgent.id)
  }
  bridge.setMode(mode)
  render()
}

function collapse() {
  if (mode === 'collapsed') return
  mode = 'collapsed'
  bridge.setMode(mode)
  render()
}

/** Another app took the keyboard. The sign-in form stays open: its key is often being copied from a password manager. */
function closeUnlessFocused() {
  if (!document.hasFocus() && client) collapse()
}

// MARK: Signing in

async function signInScreen(problem?: string) {
  const canRemember = await bridge.canRemember()
  const field = element('textarea')
  field.placeholder = 'tonton1.…'
  field.spellcheck = false
  field.autocomplete = 'off'
  const remember = element('input')
  remember.type = 'checkbox'
  remember.checked = canRemember
  remember.disabled = !canRemember
  const signIn = element('button', 'Sign in')
  signIn.className = 'primary'
  const signInError = element('p', problem ?? '')
  const relay = element('input')
  relay.placeholder = `${DEFAULT_RELAY} (or your own relay)`
  relay.spellcheck = false
  const create = element('button', 'Create account')
  const createError = element('p')
  for (const error of [signInError, createError]) error.className = 'error'
  const run = async (button: HTMLButtonElement, error: HTMLElement, work: () => ReturnType<IslandBridge['signIn']>, created: boolean) => {
    button.disabled = true
    signInError.textContent = ''
    createError.textContent = ''
    const result = await work().catch(() => ({ ok: false as const, error: 'Something went wrong. Try again.' }))
    button.disabled = false
    if (!result.ok) {
      error.textContent = result.error
      return
    }
    notice = created
      ? 'Account created. To add a machine, ⋯ › Add a machine copies the command to run in a terminal there. Keep the recovery key (⋯ › Copy the recovery key) in your password manager: it signs you in elsewhere.'
      : null
    void connect(result.account)
  }
  signIn.onclick = () => void run(signIn, signInError, () => bridge.signIn(field.value, remember.checked), false)
  create.onclick = () =>
    void run(create, createError, () => bridge.createAccount(relay.value.trim() || DEFAULT_RELAY, remember.checked), true)
  const form = element(
    'div',
    element('h1', 'Sign in'),
    element('p', 'Paste the recovery key of your account: Settings › Relay › Recovery key in the Mac app.'),
    field,
    signIn,
    signInError,
    element('h2', 'New here'),
    element('p', 'Create an account on the hosted relay, or on yours. Its key is made on this computer and never goes to the relay.'),
    relay,
    create,
    createError,
    element(
      'label',
      remember,
      canRemember ? ' Remember on this computer' : ' Remember on this computer: not possible here, there is no keyring to keep it in',
    ),
  )
  form.className = 'sign-in'
  client?.stop()
  client = null
  state = null
  panel.replaceChildren(form)
  render()
  if (mode === 'collapsed') expand()
  field.focus()
}

async function connect(account: IslandAccount) {
  let key: CryptoKey
  try {
    key = await importAccountKey(account.key)
  } catch {
    return signOut('This account key is damaged.')
  }
  host = new URL(account.relay).host
  client?.stop()
  known = new Map()
  client = new RelayClient({
    vault: new Vault(key),
    // No token here: the main process adds it to the handshake (src/main/relay-auth.ts).
    connect: () => new WebSocket(appSocketUrl(account.relay)) as unknown as SocketLike,
    onChange: next => {
      state = next
      render()
    },
    onEvent: event => {
      if (event.t === 'snapshot') known = new Map(event.sessions.map(s => [s.id, s]))
      if (event.t !== 'session') return
      const alert = sessionAlert(known.get(event.session.id), event.session)
      known = new Map(known).set(event.session.id, event.session)
      if (alert && mode === 'collapsed') startPeek(event.session)
    },
    onSignedOut: () => void signOut('The relay signed this computer out.'),
  })
  layout()
  client.start()
}

async function signOut(problem: string | null, tellMain = true) {
  client?.stop()
  client = null
  state = null
  notice = null
  if (tellMain) await bridge.signOut()
  await signInScreen(problem ?? undefined)
}

// MARK: Layout

function layout() {
  const list = element('nav')
  const chat = element('main')
  const shell = element('div', list, chat)
  shell.className = 'shell'
  Object.assign(parts, { list, chat, shell })
  const children: HTMLElement[] = [shell]
  if (notice) {
    const close = element('button', 'OK')
    const box = element('div', element('p', notice), close)
    box.className = 'notice'
    close.onclick = () => {
      notice = null
      box.remove()
    }
    children.unshift(box)
  }
  panel.replaceChildren(...children)
}

function render() {
  app.dataset.mode = mode
  app.dataset.alert = peek ? 'peek' : ''
  bar.replaceChildren(...barContent())
  if (!state || mode !== 'expanded' || !parts.list || !parts.chat || !parts.shell) return
  parts.shell.dataset.view = showingChat && state.selectedId ? 'chat' : 'list'
  renderList(parts.list, state, session => {
    showingChat = true
    client?.select(session.id)
    render()
  })
  renderChat(parts.chat, state, client, () => {
    showingChat = false
    render()
  })
}

/** Closed: the session to look at and what it does, or what all of them do. Open: the account and the menu. */
function barContent(): (HTMLElement | string)[] {
  const title = element('span')
  title.className = 'title'
  if (!state) {
    title.append(element('strong', 'Tonton Claude'), element('small', 'Sign in'))
    return [title]
  }
  const live = state.sessions.filter(s => isLive(s.status))
  const attention = live.filter(s => needsAttention(s.status)).length
  const count = element('span', String(live.length))
  count.className = attention ? 'count attention' : 'count'
  count.title = attention ? `${attention} waiting for you` : `${live.length} live`
  if (mode === 'expanded') {
    const more = element('button', '⋯')
    more.className = 'more'
    more.title = 'Menu'
    more.onclick = event => {
      event.stopPropagation()
      bridge.showMenu()
    }
    const connection = state.connection === 'connected' ? host : state.connection === 'connecting' ? 'Connecting…' : 'Offline'
    const urgent = mostUrgent(live.map(s => s.status))
    title.append(element('strong', 'Tonton Claude'), element('small', connection))
    return [...(urgent ? [dot(urgent)] : []), title, count, more]
  }
  if (peek) {
    // Like the notch's banner: where it runs, and its status.
    title.append(element('strong', `${peek.machine} · ${peek.name ?? peek.project}`), element('small', STATUS_LABELS[peek.status]))
    return [dot(peek.status), title, count]
  }
  const activity = liveActivity(state.sessions)
  if (activity) {
    title.append(element('strong', activity.name ?? activity.project), element('small', liveActivityText(activity)))
    return [dot(activity.status), title, count]
  }
  const quiet =
    state.connection === 'connected'
      ? live.length
        ? 'All done'
        : 'No live sessions'
      : state.connection === 'connecting'
        ? 'Connecting…'
        : 'Offline'
  title.append(element('strong', 'Tonton Claude'), element('small', quiet))
  return [...(live.length ? [dot('idle')] : []), title, count]
}

function startPeek(session: Session) {
  peek = session
  clearTimeout(peekTimer)
  peekTimer = setTimeout(() => {
    endPeek()
    render()
  }, PEEK_MS)
  render()
}

function endPeek() {
  peek = null
  clearTimeout(peekTimer)
}

start()
