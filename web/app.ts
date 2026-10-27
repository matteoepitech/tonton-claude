// Tonton Claude in a browser: the account's sessions, their conversations, messages and permission requests, from any
// computer or phone. Built on the client core (shared/), which decrypts in the page: the account key never reaches the
// relay. Signing in takes the recovery key of the Mac app (Settings › Relay), pasted or scanned from the QR code of
// Settings › Machines; remembering it keeps the key as a CryptoKey that no script can read back. A read-only share key,
// pasted or after the # of the address, shows one session instead.

import {
  browserSocket,
  type ClientState,
  importAccountKey,
  parseAccountToken,
  parseRecoveryKey,
  parseShareLink,
  RelayClient,
  type ShareLink,
  ShareViewer,
  type SocketLike,
  shareSocket,
  toggledFold,
  Vault,
} from '../shared'
import { element } from './markdown'
import { cameraProblem, canScan, type Scan, startScan } from './scanner'
import { renderChat, renderList, renderShared } from './views'

const FOLDED_KEY = 'tonton.foldedMachines'

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
/** Machines folded in the list, kept in this browser only: a convenience, lost with the site's data. */
let foldedMachines = loadFolded()

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
  const actions = element('div', button)
  actions.className = 'actions'
  const camera = element('div')
  camera.className = 'scanner'
  camera.hidden = true
  const form = element(
    'form',
    element('h1', 'Tonton Claude'),
    element(
      'p',
      'Paste the recovery key of your account, from the Mac app: Settings › Relay › Recovery key, or scan its QR code in Settings › Machines. Or the read-only share key a teammate sent you.',
    ),
    field,
    camera,
    element('label', remember, ' Remember on this device'),
    error,
    actions,
    element('p', 'Whoever has this key can read and drive your sessions. It stays in this browser and never goes to the relay.'),
  )
  form.className = 'sign-in'

  const scanner = qrScanner(camera, field, error, () => form.requestSubmit())
  if (scanner.button) actions.append(scanner.button)

  form.onsubmit = async event => {
    event.preventDefault()
    scanner.stop()
    const shared = parseShareLink(field.value)
    if (shared) return watch(shared)
    const account = parseRecoveryKey(field.value)
    if (!account) {
      error.textContent = parseAccountToken(field.value)
        ? 'This is the token machines join with, not the recovery key: Settings › Relay › Recovery key.'
        : 'This is not a Tonton Claude recovery key nor a share key.'
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

/**
 * The Scan button, and the camera in place of the field while it looks for the QR code of Settings › Machines. A code
 * that holds a key goes into the field and signs in like a pasted one. Each scan or stop is a new attempt, so a camera
 * that starts after it was cancelled stops at once.
 */
function qrScanner(camera: HTMLElement, field: HTMLTextAreaElement, error: HTMLElement, signIn: () => void) {
  let scan: Scan | null = null
  let attempt = 0
  const button = canScan() ? element('button', 'Scan the QR code') : null
  const stop = () => {
    attempt++
    scan?.stop()
    scan = null
    camera.replaceChildren()
    camera.hidden = true
    field.hidden = false
    if (button) button.hidden = false
  }
  const start = async () => {
    stop()
    const current = attempt
    error.textContent = ''
    const video = element('video')
    const hint = element('p', 'Point the camera at the QR code in the Mac app: Settings › Machines › Phone or browser.')
    const cancel = element('button', 'Cancel')
    cancel.type = 'button'
    cancel.onclick = stop
    camera.replaceChildren(video, hint, cancel)
    camera.hidden = false
    field.hidden = true
    if (button) button.hidden = true
    try {
      const started = await startScan(video, text => {
        if (!parseRecoveryKey(text) && !parseShareLink(text)) {
          hint.textContent = parseAccountToken(text)
            ? 'This is the token machines join with. Scan the code under Settings › Machines › Phone or browser.'
            : 'This QR code is not a Tonton Claude key.'
          return false
        }
        stop()
        field.value = text
        signIn()
        return true
      })
      if (current === attempt) scan = started
      else started.stop()
    } catch (problem) {
      if (current !== attempt) return
      stop()
      error.textContent = cameraProblem(problem)
    }
  }
  if (button) {
    button.type = 'button'
    button.onclick = () => void start()
  }
  return { button, stop }
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
  renderList(
    parts.list,
    state,
    session => {
      showingChat = true
      client?.select(session.id)
      render()
    },
    {
      folded: foldedMachines,
      toggle: key => {
        foldedMachines = toggledFold(foldedMachines, key)
        saveFolded(foldedMachines)
        render()
      },
    },
  )
  renderChat(parts.chat, state, client, () => {
    showingChat = false
    render()
  })
}

function loadFolded(): Set<string> {
  try {
    const keys = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]')
    return new Set(Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveFolded(folded: ReadonlySet<string>) {
  try {
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...folded]))
  } catch {}
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
