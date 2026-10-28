// One session a teammate shared: its conversation, live, and nothing that could act on it.
import { type SharedView, STATUS_LABELS } from '../../../shared'
import { StatusDot } from '../common'
import { useStore } from '../store'
import { Button } from '../ui/button'
import { Conversation } from './chat'

export function SharedSession() {
  const store = useStore()
  const view = store.shared as SharedView
  const relay = store.sharedRelay ? new URL(store.sharedRelay).host : ''
  const details = [view.title, view.tool === 'opencode' ? 'OpenCode' : null].filter(Boolean).join(' · ')
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-2.5">
        <strong>Tonton Claude</strong>
        <Connection state={view.connection === 'connected' ? 'connected' : view.connection === 'ended' ? 'ended' : 'connecting'} />
        <span className="text-xs text-muted-foreground">Read only · {relay}</span>
        <Button variant="outline" size="sm" className="ms-auto" onClick={() => store.closeShare()}>
          Close
        </Button>
      </header>
      <div className="flex items-center gap-2.5 border-b px-4 py-2.5">
        {view.status && <StatusDot status={view.status} />}
        <span className="flex min-w-0 flex-col">
          <strong className="truncate">{view.project ?? 'Shared session'}</strong>
          <small className="truncate text-xs text-muted-foreground">{details}</small>
        </span>
        <em className="ms-auto text-xs text-muted-foreground not-italic">{view.status ? STATUS_LABELS[view.status] : ''}</em>
      </div>
      <Conversation entries={view.entries} />
      {view.connection === 'ended' && (
        <p className="border-t p-3 text-center text-sm text-muted-foreground">This share ended: it was revoked or it expired.</p>
      )}
    </div>
  )
}

export function Connection({ state }: { state: 'connected' | 'connecting' | 'offline' | 'ended' }) {
  const label = { connected: '● connected', connecting: '○ connecting', offline: '○ offline', ended: '○ ended' }[state]
  return <span className={state === 'connected' ? 'text-xs text-success' : 'text-xs text-muted-foreground'}>{label}</span>
}
