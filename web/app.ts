// Tonton Claude in a browser: the account's sessions, their conversations, messages and permission requests, from any
// computer or phone. Built on the client core (shared/), which decrypts in the page: the account key never reaches the
// relay. Signing in takes the recovery key of the Mac app (Settings › Relay); remembering it keeps the key as a CryptoKey
// that no script can read back. A read-only share key, pasted or after the # of the address, shows one session instead.

import {
  accepts,
  browserSocket,
  type ClientState,
  chatItems,
  displayStatusText,
  importAccountKey,
  isLive,
  keepsSessionRules,
  menuCommands,
  modelName,
  needsAttention,
  parseRecoveryKey,
  parseShareLink,
  RelayClient,
  type Session,
  type SharedView,
  type ShareLink,
  ShareViewer,
  type SocketLike,
  STATUS_LABELS,
  sessionRuleFor,
  shareSocket,
  Vault,
} from '../shared'
import type { SessionCommand, SessionStatus } from '../shared/protocol'
import { element, inline, renderMarkdown } from './markdown'

interface Saved {
  relay: string
  token: string
  key: CryptoKey
}

const app = document.getElementById('app') as HTMLElement
let client: RelayClient | null = null
let state: ClientState | null = null
let viewer: ShareViewer | null = null
/** On phones, the list or one conversation. */
let showingChat = false

async function start() {
  const shared = parseShareLink(location.hash)
  if (shared) return watch(shared)
  const saved = await load().catch(() => null)
  if (saved) connect(saved)
  else signInScreen()
}

// MARK: Signing in

function signInScreen(problem?: string) {
  const field = element('textarea')
  field.placeholder = 'tonton1.… or tontonshare1.…'
  field.spellcheck = false
  field.autocomplete = 'off'
  const remember = element('input')
  remember.type = 'checkbox'
  remember.checked = true
  const error = element('p', problem ?? '')
  error.className = 'error'
  const button = element('button', 'Sign in')
  button.className = 'primary'
  const form = element(
    'form',
    element('h1', 'Tonton Claude'),
    element(
      'p',
      'Paste the recovery key of your account, from the Mac app: Settings › Relay › Recovery key. Or the read-only share key a teammate sent you.',
    ),
    field,
    element('label', remember, ' Remember on this device'),
    error,
    button,
    element('p', 'Whoever has this key can read and drive your sessions. It stays in this browser and never goes to the relay.'),
  )
  form.className = 'sign-in'
  form.onsubmit = async event => {
    event.preventDefault()
    const shared = parseShareLink(field.value)
    if (shared) return watch(shared)
    const account = parseRecoveryKey(field.value)
    if (!account) {
      error.textContent = 'This is not a Tonton Claude recovery key nor a share key.'
      return
    }
    const key = await importAccountKey(account.key)
    const saved = { relay: account.relay, token: account.token, key }
    if (remember.checked) await save(saved).catch(() => {})
    connect(saved)
  }
  app.replaceChildren(form)
  field.focus()
}

function connect(saved: Saved) {
  client?.stop()
  client = new RelayClient({
    vault: new Vault(saved.key),
    // The DOM's handlers take events this client does not read: the socket fits SocketLike.
    connect: () => browserSocket(saved.relay, saved.token, (url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike),
    onChange: next => {
      state = next
      render()
    },
    onSignedOut: () => signOut('The relay signed this device out.'),
  })
  layout(new URL(saved.relay).host)
  client.start()
}

async function signOut(problem?: string) {
  client?.stop()
  client = null
  state = null
  await forget().catch(() => {})
  signInScreen(problem)
}

// MARK: Layout

const parts: { list?: HTMLElement; chat?: HTMLElement; status?: HTMLElement; shell?: HTMLElement } = {}

function layout(host: string) {
  const status = element('span')
  status.className = 'connection'
  const out = element('button', 'Sign out')
  out.onclick = () => void signOut()
  const header = element('header', element('strong', 'Tonton Claude'), status, element('span', host), out)
  const list = element('nav')
  const chat = element('main')
  const shell = element('div', list, chat)
  shell.className = 'shell'
  Object.assign(parts, { list, chat, status, shell })
  app.replaceChildren(header, shell)
}

function render() {
  if (!state || !parts.list || !parts.chat || !parts.status || !parts.shell) return
  parts.status.textContent =
    state.connection === 'connected' ? '● connected' : state.connection === 'connecting' ? '○ connecting' : '○ offline'
  parts.status.dataset.state = state.connection
  parts.shell.dataset.view = showingChat && state.selectedId ? 'chat' : 'list'
  renderList(parts.list, state)
  renderChat(parts.chat, state)
}

// MARK: Sessions

function renderList(list: HTMLElement, current: ClientState) {
  const groups = new Map<string, Session[]>()
  for (const session of current.sessions) groups.set(session.machine, [...(groups.get(session.machine) ?? []), session])
  const children: HTMLElement[] = []
  if (!current.sessions.length) children.push(element('p', current.connection === 'connected' ? 'No sessions yet.' : 'Connecting…'))
  for (const [machine, sessions] of groups) {
    children.push(element('h2', machine))
    for (const session of sessions) {
      const row = element(
        'button',
        dot(session.status),
        element(
          'span',
          element('strong', session.project),
          element('small', needsAttention(session.status) ? displayStatusText(session) : (session.title ?? STATUS_LABELS[session.status])),
        ),
      )
      row.className = 'session'
      if (session.id === current.selectedId) row.classList.add('selected')
      if (!isLive(session.status)) row.classList.add('finished')
      row.onclick = () => {
        showingChat = true
        client?.select(session.id)
        render()
      }
      children.push(row)
    }
  }
  list.replaceChildren(...children)
}

function dot(status: SessionStatus): HTMLElement {
  const node = element('i')
  node.className = `dot ${status}`
  node.title = STATUS_LABELS[status]
  return node
}

// MARK: Conversation

/** Kept across renders: what is being typed, and whether the conversation follows its end. */
let draft = ''
let stickToBottom = true

function renderChat(chat: HTMLElement, current: ClientState) {
  const session = current.sessions.find(s => s.id === current.selectedId)
  if (!session) {
    chat.replaceChildren(element('p', 'Pick a session.'))
    return
  }
  const previous = chat.querySelector('.messages')
  if (previous) stickToBottom = previous.scrollHeight - previous.scrollTop - previous.clientHeight < 40
  const back = element('button', '‹ Sessions')
  back.className = 'back'
  back.onclick = () => {
    showingChat = false
    render()
  }
  const details = [
    session.machine,
    session.branch ? `⎇ ${session.branch}` : null,
    session.model ? modelName(session.model) : null,
    session.tool === 'opencode' ? 'OpenCode' : null,
  ]
  const header = element(
    'div',
    back,
    dot(session.status),
    element('span', element('strong', session.project), element('small', details.filter(Boolean).join(' · '))),
    element('em', needsAttention(session.status) ? displayStatusText(session) : STATUS_LABELS[session.status]),
    ...commandButtons(session),
  )
  header.className = 'chat-header'
  const messages = element('div')
  messages.className = 'messages'
  if (!current.entries) messages.append(element('p', 'Loading the conversation…'))
  for (const item of chatItems(current.entries ?? [])) messages.append(message(item))
  for (const request of session.pendingPermissions) messages.append(permission(session, request))
  chat.replaceChildren(header, messages, composer(session))
  if (stickToBottom) messages.scrollTop = messages.scrollHeight
}

function message(item: ReturnType<typeof chatItems>[number]): HTMLElement {
  if (item.kind === 'user') {
    const bubble = element('div', ...inline(item.entry.text))
    bubble.className = 'user'
    return bubble
  }
  if (item.kind === 'assistant') {
    const text = element('div', renderMarkdown(item.entry.text))
    text.className = 'assistant'
    return text
  }
  if (item.kind === 'system') {
    const note = element('p', item.entry.text)
    note.className = 'system'
    return note
  }
  const summary = element('summary', element('strong', item.call.name), ` ${item.call.summary}`)
  const tool = element('details', summary)
  tool.className = item.result?.isError ? 'tool failed' : item.result ? 'tool' : 'tool running'
  if (item.result?.text) tool.append(element('pre', item.result.text))
  for (const edit of item.call.edits ?? []) {
    const diff = element('pre')
    diff.className = 'diff'
    diff.append(element('del', edit.oldText), element('ins', edit.newText))
    tool.append(diff)
  }
  return tool
}

function permission(session: Session, request: Session['pendingPermissions'][number]): HTMLElement {
  const allow = element('button', 'Allow')
  allow.className = 'primary'
  const deny = element('button', 'Deny')
  allow.onclick = () => client?.answer(session.id, request.requestId, true)
  deny.onclick = () => client?.answer(session.id, request.requestId, false)
  const buttons = element('div', deny)
  const machine = state?.machines.find(m => m.id === session.machineId)
  const rule = keepsSessionRules(machine) ? sessionRuleFor(request.toolName, request.inputPreview) : null
  if (rule) {
    const label = rule.label.length > 40 ? `${rule.label.slice(0, 40)}…` : rule.label
    const always = element('button', `Allow for this session: ${label}`)
    always.title = `${rule.label}: calls like this one are allowed until the session ends.`
    always.onclick = () => void client?.allowForSession(session.id, request.requestId, rule.rules)
    buttons.append(always)
  }
  buttons.append(allow)
  const card = element('div', element('strong', `${request.toolName} wants to run`), element('pre', request.description), buttons)
  card.className = 'permission'
  return card
}

function composer(session: Session): HTMLElement {
  const field = element('textarea')
  field.rows = 2
  field.value = draft
  field.disabled = !session.canChat
  field.placeholder = session.canChat
    ? 'Message Claude… (Enter sends, Shift+Enter: new line)'
    : 'Read only: this session takes no messages from here.'
  field.oninput = () => {
    draft = field.value
  }
  const send = element('button', 'Send')
  send.className = 'primary'
  send.disabled = !session.canChat
  const submit = async () => {
    const text = field.value.trim()
    if (!text || !client) return
    if (await client.sendPrompt(session.id, text)) {
      draft = ''
      field.value = ''
    }
  }
  send.onclick = () => void submit()
  field.onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void submit()
    }
  }
  const form = element('div', field, send)
  form.className = 'composer'
  return form
}

/** Interrupt while it works; compact and clear while it waits. Only what its agent says it runs. */
function commandButtons(session: Session): HTMLElement[] {
  const names: SessionCommand['name'][] = [...(accepts(session, 'interrupt') ? (['interrupt'] as const) : []), ...menuCommands(session)]
  const labels: Record<string, string> = { interrupt: 'Stop', compact: 'Compact', clear: 'Clear' }
  return names.map(name => {
    const button = element('button', labels[name] ?? name)
    button.disabled = !accepts(session, name)
    button.onclick = () => {
      if (name === 'clear' && !confirm('Clear the conversation? Claude starts over.')) return
      void client?.sendCommand(session.id, name)
    }
    return button
  })
}

// MARK: Read-only share

/** One session a teammate shared: its conversation, live, and nothing that could act on it. Nothing is stored. */
async function watch(link: ShareLink) {
  client?.stop()
  client = null
  viewer?.stop()
  let key: CryptoKey
  try {
    key = await importAccountKey(link.key)
  } catch {
    return signInScreen('This share key is damaged.')
  }
  const close = element('button', 'Close')
  close.onclick = () => {
    viewer?.stop()
    viewer = null
    history.replaceState(null, '', location.pathname + location.search)
    signInScreen()
  }
  const status = element('span')
  status.className = 'connection'
  const header = element(
    'header',
    element('strong', 'Tonton Claude'),
    status,
    element('span', `Read only · ${new URL(link.relay).host}`),
    close,
  )
  const chat = element('main')
  const shell = element('div', chat)
  shell.className = 'shell'
  shell.dataset.view = 'shared'
  app.replaceChildren(header, shell)
  viewer = new ShareViewer({
    key,
    connect: () => shareSocket(link, (url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike),
    onChange: view => renderShared(view, status, chat),
  })
  viewer.start()
}

function renderShared(view: SharedView, status: HTMLElement, chat: HTMLElement) {
  status.textContent = view.connection === 'connected' ? '● connected' : view.connection === 'ended' ? '○ ended' : '○ connecting'
  status.dataset.state = view.connection === 'connected' ? 'connected' : 'offline'
  const previous = chat.querySelector('.messages')
  if (previous) stickToBottom = previous.scrollHeight - previous.scrollTop - previous.clientHeight < 40
  const details = [view.title, view.tool === 'opencode' ? 'OpenCode' : null].filter(Boolean).join(' · ')
  const header = element(
    'div',
    ...(view.status ? [dot(view.status)] : []),
    element('span', element('strong', view.project ?? 'Shared session'), element('small', details)),
    element('em', view.status ? STATUS_LABELS[view.status] : ''),
  )
  header.className = 'chat-header'
  const messages = element('div')
  messages.className = 'messages'
  if (!view.entries) messages.append(element('p', 'Loading the conversation…'))
  for (const item of chatItems(view.entries ?? [])) messages.append(message(item))
  const children: HTMLElement[] = [header, messages]
  if (view.connection === 'ended') {
    const ended = element('p', 'This share ended: it was revoked or it expired.')
    ended.className = 'ended'
    children.push(ended)
  }
  chat.replaceChildren(...children)
  if (stickToBottom) messages.scrollTop = messages.scrollHeight
}

// MARK: Storage

/** IndexedDB keeps a CryptoKey as it is: the page can use it, never read it. */
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('tonton', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('account')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function store<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const request = run(db.transaction('account', mode).objectStore('account'))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function save(saved: Saved) {
  return store('readwrite', objects => objects.put(saved, 'current'))
}

function load() {
  return store<Saved | undefined>('readonly', objects => objects.get('current'))
}

function forget() {
  return store('readwrite', objects => objects.delete('current'))
}

// Last, once every declaration above is in place.
start()
