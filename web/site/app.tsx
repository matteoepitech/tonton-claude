// The website: signing in, the account's sessions with their conversations, and the pools. On phones the list and the
// page it opens take the screen one after the other.
import { LogOutIcon } from 'lucide-react'
import { Empty, Loading } from './common'
import { DotField } from './dots'
import { PixelLogo } from './logo'
import { Pools } from './pools/pools'
import { HeroPage } from './rpg'
import { Chat } from './sessions/chat'
import { SessionList } from './sessions/list'
import { Connection, SharedSession } from './sessions/shared'
import { SignIn } from './sign-in'
import { useStore } from './store'
import { Button } from './ui/button'
import { cn } from './ui/cn'
import { Tabs, TabsList, TabsTrigger } from './ui/tabs'

export function App() {
  return (
    <>
      <DotField />
      <Page />
    </>
  )
}

function Page() {
  const store = useStore()
  if (store.starting) return <Loading>Opening…</Loading>
  if (store.shared) return <SharedSession />
  if (!store.saved || !store.state) return <SignIn />
  return <Shell />
}

/** The three places of the site. */
const MODES = [
  { value: 'sessions', label: 'Sessions' },
  { value: 'pools', label: 'Pools' },
  { value: 'hero', label: 'Tonton' },
] as const

function Shell() {
  const store = useStore()
  const state = store.state
  const saved = store.saved
  if (!state || !saved) return null
  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b bg-white px-5 py-2.5">
        <span className="flex items-center gap-2">
          <PixelLogo />
          <strong className="text-base font-bold whitespace-nowrap tracking-tight">Tonton Claude</strong>
        </span>
        <Tabs value={store.mode} onValueChange={value => store.setMode(value as typeof store.mode)}>
          <TabsList className="h-auto gap-1 border-0 bg-transparent p-0">
            {MODES.map(mode => (
              <TabsTrigger
                key={mode.value}
                value={mode.value}
                className="h-8 px-2.5 focus-visible:bg-accent focus-visible:ring-0 data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:font-semibold"
              >
                {mode.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <span className="ms-auto flex items-center gap-3">
          <Connection
            state={state.connection === 'connected' ? 'connected' : state.connection === 'connecting' ? 'connecting' : 'offline'}
          />
          <span className="hidden text-xs text-muted-foreground lg:inline">{new URL(saved.relay).host}</span>
          <Button variant="ghost" size="sm" onClick={() => void store.signOut()}>
            <LogOutIcon />
            Sign out
          </Button>
        </span>
      </header>
      {store.mode === 'pools' ? <Pools /> : store.mode === 'hero' ? <HeroPage key={saved.accountId ?? saved.relay} /> : <Sessions />}
    </div>
  )
}

function Sessions() {
  const store = useStore()
  const state = store.state
  if (!state) return null
  const session = state.sessions.find(s => s.id === state.selectedId)
  const showChat = store.showingChat && session
  return (
    <div className="grid min-h-0 flex-1 md:grid-cols-[280px_1fr]">
      <nav className={cn('rule-dashed overflow-y-auto border-e bg-white p-2', showChat && 'hidden md:block')}>
        <SessionList state={state} folded={store.folded} onPick={picked => store.select(picked.id)} onFold={key => store.toggleFold(key)} />
      </nav>
      <main className={cn('flex min-h-0 min-w-0 flex-col overflow-hidden', session && 'bg-white', !showChat && 'hidden md:flex')}>
        {session ? (
          // Keyed by the session: its own files view, its own draft.
          <Chat key={session.id} session={session} state={state} client={store.client} onBack={() => store.select(null)} />
        ) : (
          <Empty className="eyebrow raised m-auto rounded-md border bg-white px-4 py-2.5">Pick a session</Empty>
        )}
        {state.error && <p className="border-t px-4 py-2 text-xs text-destructive">{state.error}</p>}
      </main>
    </div>
  )
}
