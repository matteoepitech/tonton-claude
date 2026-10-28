// What the website knows, outside React: the account it signed in with, the relay client and its state, a read-only
// share, and the pools. React reads it through `useStore` and redraws when it changes. Built on the client core
// (shared/), which decrypts in the page: the account key never reaches the relay. Signing in takes the recovery key of
// the Mac app, pasted or scanned; remembering it keeps the key as a CryptoKey that no script can read back.

import { useSyncExternalStore } from 'react'
import {
  browserSocket,
  type ClientState,
  importAccountKey,
  PoolApi,
  PoolWatch,
  parseAccountToken,
  parsePoolInvite,
  parseRecoveryKey,
  parseShareLink,
  RelayClient,
  type SharedView,
  ShareViewer,
  type SocketLike,
  shareSocket,
  toggledFold,
  Vault,
} from '../../shared'

export interface Saved {
  relay: string
  token: string
  key: CryptoKey
  /** Missing for a browser that signed in before pools: asked of the relay then. */
  accountId?: string
}

/** What the pools side shows: a pool on one of its pages, the form for a new pool, the one to join, or nothing yet. */
export type PoolView = { kind: 'pool'; id: string } | { kind: 'new' } | { kind: 'join'; invite?: string } | null

const FOLDED_KEY = 'tonton.foldedMachines'
/** The notch's link to a pool (`PoolLinks.website` in the app): the id after the `#`, never sent to the relay. */
const POOL_LINK = /^#pool=([A-Za-z0-9_-]{12})$/

export class Store {
  saved: Saved | null = null
  client: RelayClient | null = null
  state: ClientState | null = null
  /** A teammate's session, read only, when the page opened on a share key. */
  shared: SharedView | null = null
  sharedRelay: string | null = null
  /** Why the page shows the sign-in again. */
  signInProblem: string | null = null
  /** Still reading what this browser remembers. */
  starting = true
  mode: 'sessions' | 'pools' = 'sessions'
  /** On phones, the list or one conversation. */
  showingChat = false
  folded: ReadonlySet<string> = loadFolded()
  pools: PoolWatch | null = null
  poolsProblem: string | null = null
  /** This account's id, for the pools. */
  account: string | null = null
  poolView: PoolView = null
  poolTab = 'orchestrator'
  /** A hackathon just made: its Invites tab opens on the team's QR code, once. */
  teamQrFor: string | null = null
  /** A pool to open once the list has it, from the notch's link. */
  private wantedPool: string | null = null

  private viewer: ShareViewer | null = null
  private version = 0
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = () => this.version

  changed() {
    this.version++
    for (const listener of this.listeners) listener()
  }

  async start() {
    const shared = parseShareLink(location.hash)
    if (shared) {
      this.starting = false
      return this.watch(location.hash)
    }
    this.takeLink()
    // The notch opens a pool in a tab where the site may already be: only the address after the # changes.
    window.addEventListener('hashchange', () => {
      if (this.takeLink() && this.saved) this.setMode('pools')
    })
    const saved = await load().catch(() => null)
    this.starting = false
    if (saved) this.connect(saved)
    else this.changed()
  }

  /**
   * An invite opened from its link (the join form waits for the sign-in), or the notch's link to a pool. Both leave the
   * address bar and the history: an invite holds the pool key.
   */
  private takeLink(): boolean {
    const pool = POOL_LINK.exec(location.hash)?.[1]
    if (parsePoolInvite(location.hash)) this.poolView = { kind: 'join', invite: location.hash.slice(1) }
    else if (pool) this.wantedPool = pool
    else return false
    this.mode = 'pools'
    history.replaceState(null, '', location.pathname + location.search)
    this.openWanted()
    return true
  }

  /** Opens the pool the notch asked for, once the list has it. */
  private openWanted() {
    const id = this.wantedPool
    if (!id || !this.pools?.pools.some(listed => listed.summary.id === id)) return
    this.wantedPool = null
    this.showPool({ kind: 'pool', id })
  }

  /** The text pasted or scanned: a recovery key signs in, a share key opens the shared session. */
  async signIn(text: string, remember: boolean): Promise<string | null> {
    if (parseShareLink(text)) return this.watch(text)
    const account = parseRecoveryKey(text)
    if (!account) {
      return parseAccountToken(text)
        ? 'This is the token machines join with, not the recovery key: Settings › Relay › Recovery key.'
        : 'This is not a Tonton Claude recovery key nor a share key.'
    }
    const key = await importAccountKey(account.key)
    const saved = { relay: account.relay, token: account.token, key, accountId: account.accountId }
    if (remember) await save(saved).catch(() => {})
    this.connect(saved)
    return null
  }

  connect(account: Saved) {
    this.client?.stop()
    this.saved = account
    this.pools = null
    this.poolsProblem = null
    this.signInProblem = null
    this.client = new RelayClient({
      vault: new Vault(account.key),
      // The DOM's handlers take events this client does not read: the socket fits SocketLike.
      connect: () =>
        browserSocket(account.relay, account.token, (url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike),
      onChange: next => {
        this.state = next
        this.changed()
      },
      onSignedOut: () => void this.signOut('The relay signed this device out.'),
      onPoolUpdate: update => void this.pools?.handle(update),
    })
    this.state = this.client.state
    this.client.start()
    if (this.mode === 'pools') void this.openPools()
    this.changed()
  }

  async signOut(problem?: string) {
    this.client?.stop()
    Object.assign(this, { client: null, state: null, saved: null, pools: null, account: null, poolView: null, mode: 'sessions' })
    this.signInProblem = problem ?? null
    await forget().catch(() => {})
    this.changed()
  }

  setMode(mode: Store['mode']) {
    this.mode = mode
    if (mode === 'pools') void this.openPools()
    this.changed()
  }

  /** Opens a session's conversation: the relay then sends it. */
  select(sessionId: string | null) {
    this.client?.select(sessionId)
    this.showingChat = sessionId !== null
    this.changed()
  }

  toggleFold(key: string) {
    this.folded = toggledFold(this.folded, key)
    try {
      localStorage.setItem(FOLDED_KEY, JSON.stringify([...this.folded]))
    } catch {}
    this.changed()
  }

  // MARK: Pools

  /** Pools use the relay's routes as well as its socket: the page's policy allows them on the relay's own website only. */
  async openPools() {
    if (this.pools || !this.saved || !this.client) return
    const account = this.saved
    if (!location.protocol.startsWith('http') || new URL(account.relay).origin !== location.origin) {
      this.poolsProblem = `Pools are on your relay's website: open ${account.relay} and sign in there.`
      return this.changed()
    }
    let accountId = account.accountId
    if (!accountId) {
      try {
        const ping = await (await fetch(`${account.relay}/api/ping`, { headers: { authorization: `Bearer ${account.token}` } })).json()
        accountId = typeof ping?.accountId === 'string' ? ping.accountId : undefined
      } catch {}
    }
    if (!accountId) {
      this.poolsProblem = 'The relay did not say which account this is: sign in again with the recovery key.'
      return this.changed()
    }
    this.account = accountId
    this.pools = new PoolWatch({
      api: new PoolApi({ relay: account.relay, token: account.token }),
      accountKey: account.key,
      account: accountId,
      relay: account.relay,
      link: this.client,
      onChange: () => this.changed(),
    })
    this.changed()
    await this.pools.refresh()
    this.openWanted()
  }

  showPool(view: PoolView, tab?: string) {
    const current = this.poolView
    if (current?.kind === 'pool' && (view?.kind !== 'pool' || view.id !== current.id)) this.pools?.close(current.id)
    this.poolView = view
    if (view?.kind === 'pool') {
      if (current?.kind !== 'pool' || current.id !== view.id) this.pools?.open(view.id)
      this.poolTab = tab ?? 'orchestrator'
    }
    this.changed()
  }

  setPoolTab(tab: string) {
    this.poolTab = tab
    this.changed()
  }

  // MARK: Read-only share

  /** One session a teammate shared: its conversation, live, and nothing that could act on it. Nothing is stored. */
  private async watch(text: string): Promise<string | null> {
    const link = parseShareLink(text)
    if (!link) return null
    let key: CryptoKey
    try {
      key = await importAccountKey(link.key)
    } catch {
      this.signInProblem = 'This share key is damaged.'
      this.changed()
      return this.signInProblem
    }
    this.client?.stop()
    this.client = null
    this.viewer?.stop()
    this.sharedRelay = link.relay
    this.viewer = new ShareViewer({
      key,
      connect: () => shareSocket(link, (url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike),
      onChange: view => {
        this.shared = view
        this.changed()
      },
    })
    this.viewer.start()
    return null
  }

  closeShare() {
    this.viewer?.stop()
    this.viewer = null
    this.shared = null
    this.sharedRelay = null
    history.replaceState(null, '', location.pathname + location.search)
    this.changed()
  }
}

export const store = new Store()

/** The store, and a redraw of the component whenever it changes. */
export function useStore(): Store {
  useSyncExternalStore(store.subscribe, store.snapshot)
  return store
}

function loadFolded(): Set<string> {
  try {
    const keys = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]')
    return new Set(Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : [])
  } catch {
    return new Set()
  }
}

// MARK: What this browser remembers

/** IndexedDB keeps a CryptoKey as it is: the page can use it, never read it. */
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('tonton', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('account')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function objects<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const request = run(db.transaction('account', mode).objectStore('account'))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

const save = (saved: Saved) => objects('readwrite', store => store.put(saved, 'current'))
const load = () => objects<Saved | undefined>('readonly', store => store.get('current'))
const forget = () => objects('readwrite', store => store.delete('current'))
