// Tonton Claude in a browser: the account's sessions, their conversations, messages and permission requests, from any
// computer or phone. Built on the client core (shared/), which decrypts in the page: the account key never reaches the
// relay. Signing in takes the recovery key of the Mac app (Settings › Relay), pasted or scanned from the QR code of
// Settings › Machines; remembering it keeps the key as a CryptoKey that no script can read back. A read-only share key,
// pasted or after the # of the address, shows one session instead. On the relay's own website, the Pools tab shows the
// account's pools (web/pools.ts).

import {
  browserSocket,
  type ClientState,
  importAccountKey,
  PoolApi,
  PoolWatch,
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
import { type PoolsContext, poolSelected, renderPoolList, renderPoolMain } from './pools'
import { cameraProblem, canScan, type Scan, startScan } from './scanner'
import { renderChat, renderList, renderShared } from './views'

const FOLDED_KEY = 'tonton.foldedMachines'

interface Saved {
  relay: string
  token: string
  key: CryptoKey
  /** Missing for a browser that signed in before pools: asked of the relay then. */
  accountId?: string
}

const app = document.getElementById('app') as HTMLElement
let client: RelayClient | null = null
let state: ClientState | null = null
let viewer: ShareViewer | null = null
let saved: Saved | null = null
/** The sessions, or the pools of the account. */
let mode: 'sessions' | 'pools' = 'sessions'
let pools: PoolsContext | null = null
let poolsProblem: string | null = null
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
    const signedIn = { relay: account.relay, token: account.token, key, accountId: account.accountId }
    if (remember.checked) await save(signedIn).catch(() => {})
    connect(signedIn)
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

function connect(account: Saved) {
  client?.stop()
  saved = account
  pools = null
  poolsProblem = null
  client = new RelayClient({
    vault: new Vault(account.key),
    // The DOM's handlers take events this client does not read: the socket fits SocketLike.
    connect: () => browserSocket(account.relay, account.token, (url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike),
    onChange: next => {
      state = next
      render()
    },
    onSignedOut: () => signOut('The relay signed this device out.'),
    onPoolUpdate: update => void pools?.watch.handle(update),
  })
  layout(new URL(account.relay).host)
  client.start()
}

/**
 * Pools take the relay's routes as well as its socket: the page's policy allows them on the relay's own website only.
 * Opened the first time the Pools tab is.
 */
async function openPools() {
  if (pools || !saved || !client) return
  if (!location.protocol.startsWith('http') || new URL(saved.relay).origin !== location.origin) {
    poolsProblem = `Pools are on your relay's website: open ${saved.relay} and sign in there.`
    return render()
  }
  const account = saved
  const api = new PoolApi({ relay: account.relay, token: account.token })
  let accountId = account.accountId
  if (!accountId) {
    try {
      const ping = await (await fetch(`${account.relay}/api/ping`, { headers: { authorization: `Bearer ${account.token}` } })).json()
      accountId = typeof ping?.accountId === 'string' ? ping.accountId : undefined
    } catch {}
  }
  if (!accountId) {
    poolsProblem = 'The relay did not say which account this is: sign in again with the recovery key.'
    return render()
  }
  const watch = new PoolWatch({
    api,
    accountKey: account.key,
    account: accountId,
    relay: account.relay,
    link: client,
    onChange: () => render(),
  })
  pools = { watch, account: accountId, rerender: () => render() }
  await watch.refresh()
}

async function signOut(problem?: string) {
  client?.stop()
  client = null
  state = null
  saved = null
  pools = null
  mode = 'sessions'
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
  const sessions = element('button', 'Sessions')
  const poolsTab = element('button', 'Pools')
  for (const [button, target] of [
    [sessions, 'sessions'],
    [poolsTab, 'pools'],
  ] as const) {
    button.className = 'mode'
    button.onclick = () => {
      mode = target
      if (target === 'pools') void openPools()
      render()
    }
  }
  const modes = element('div', sessions, poolsTab)
  modes.className = 'modes'
  modes.setAttribute('role', 'tablist')
  const header = element('header', element('strong', 'Tonton Claude'), modes, status, element('span', host), out)
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
  for (const button of document.querySelectorAll<HTMLButtonElement>('.modes button')) {
    button.setAttribute('aria-selected', String(button.textContent?.toLowerCase() === mode))
  }
  if (mode === 'pools') return renderPools(parts.list, parts.chat, parts.shell)
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

function renderPools(list: HTMLElement, main: HTMLElement, shell: HTMLElement) {
  if (!pools) {
    shell.dataset.view = 'list'
    list.replaceChildren(element('p', poolsProblem ?? 'Opening the pools…'))
    main.replaceChildren(element('p', poolsProblem ?? ''))
    return
  }
  shell.dataset.view = poolSelected() ? 'chat' : 'list'
  renderPoolList(list, pools)
  renderPoolMain(main, pools, () => render())
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
