// What the island's page and its main process say to each other, through the preload script (src/preload.ts). The page
// never gets the relay token: the main process keeps it and adds it to the page's socket (src/main/relay-auth.ts).

export type IslandMode = 'collapsed' | 'expanded'

export interface IslandAccount {
  relay: string
  /** Base64url AES-256 key. The page imports it as a CryptoKey it cannot read back, and drops the text. */
  key: string
}

export type SignInResult = { ok: true; account: IslandAccount } | { ok: false; error: string }

/** From the main process: the tray's items, the window losing focus, signing out from the menu. */
export type IslandCommand = 'expand' | 'collapse' | 'blur' | 'signed-out'

export interface IslandBridge {
  /** The account this computer remembers, or the one signed in since the island started. */
  account(): Promise<IslandAccount | null>
  /** False when the system has no keyring to keep the account in: it is then forgotten when the island quits. */
  canRemember(): Promise<boolean>
  signIn(recoveryKey: string, remember: boolean): Promise<SignInResult>
  /** A new account on that relay, with its key made on this computer. */
  createAccount(relay: string, remember: boolean): Promise<SignInResult>
  signOut(): Promise<void>
  setMode(mode: IslandMode): void
  /** The tray's menu, under the island's button. */
  showMenu(): void
  onCommand(listener: (command: IslandCommand) => void): void
}

export const CHANNELS = {
  account: 'island:account',
  canRemember: 'island:can-remember',
  signIn: 'island:sign-in',
  createAccount: 'island:create-account',
  signOut: 'island:sign-out',
  mode: 'island:mode',
  menu: 'island:menu',
  command: 'island:command',
} as const

/** Where the island opens at first: the hosted relay, like the Mac app. */
export const DEFAULT_RELAY = 'https://tonton.d3l.tech'
