// The website: signing in, the account's sessions with their conversations, and the pools. On phones the list and the
// page it opens take the screen one after the other.
import { LogOutIcon } from 'lucide-react'
import { Empty, Loading } from './common'
import { Pools } from './pools/pools'
import { Chat } from './sessions/chat'
import { SessionList } from './sessions/list'
import { Connection, SharedSession } from './sessions/shared'
import { SignIn } from './sign-in'
import { useStore } from './store'
import { Button } from './ui/button'
import { cn } from './ui/cn'
import { Tabs, TabsList, TabsTrigger } from './ui/tabs'

export function App() {
  const store = useStore()
  if (store.starting) return <Loading>Opening…</Loading>
  if (store.shared) return <SharedSession />
  if (!store.saved || !store.state) return <SignIn />
  return <Shell />
}

function Shell() {
  const store = useStore()
  const state = store.state
  const saved = store.saved
  if (!state || !saved) return null
  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5">
        <strong className="whitespace-nowrap">Tonton Claude</strong>
        <Tabs value={store.mode} onValueChange={value => store.setMode(value as typeof store.mode)}>
          <TabsList className="h-8">
            <TabsTrigger value="sessions">Sessions</TabsTrigger>
            <TabsTrigger value="pools">Pools</TabsTrigger>
          </TabsList>
        </Tabs>
        <Connection state={state.connection === 'connected' ? 'connected' : state.connection === 'connecting' ? 'connecting' : 'offline'} />
        <span className="hidden text-xs text-muted-foreground sm:inline">{new URL(saved.relay).host}</span>
        <Button variant="ghost" size="sm" className="ms-auto" onClick={() => void store.signOut()}>
          <LogOutIcon />
          Sign out
        </Button>
      </header>
      {store.mode === 'pools' ? <Pools /> : <Sessions />}
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
      <nav className={cn('overflow-y-auto border-e p-2', showChat && 'hidden md:block')}>
        <SessionList state={state} folded={store.folded} onPick={picked => store.select(picked.id)} onFold={key => store.toggleFold(key)} />
      </nav>
      <main className={cn('flex min-h-0 min-w-0 flex-col', !showChat && 'hidden md:flex')}>
        {session ? (
          // Keyed by the session: its own files view, its own draft.
          <Chat key={session.id} session={session} state={state} client={store.client} onBack={() => store.select(null)} />
        ) : (
          <Empty className="m-auto">Pick a session.</Empty>
        )}
        {state.error && <p className="border-t px-4 py-2 text-xs text-destructive">{state.error}</p>}
      </main>
    </div>
  )
}
