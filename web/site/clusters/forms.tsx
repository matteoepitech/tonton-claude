// Making a cluster and joining one, each on one screen: what the cluster is for and who you are in it. Sessions come
// later, one by one, from the Roster tab: only their owner puts them in.
import { ArrowLeftIcon } from 'lucide-react'
import { type FormEvent, type ReactNode, useState } from 'react'
import { parseClusterInvite } from '../../../shared'
import { Problem } from '../common'
import { useStore } from '../store'
import { Button } from '../ui/button'
import { Field, Input, Textarea } from '../ui/fields'

const NAME_KEY = 'tonton.poolName'

function FormPage({ title, detail, children }: { title: string; detail?: string; children: ReactNode }) {
  const store = useStore()
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={() => store.showCluster(null)} aria-label="Back to the clusters">
          <ArrowLeftIcon />
        </Button>
        <strong>{title}</strong>
      </div>
      <div className="flex w-full max-w-xl flex-col gap-4 p-4">
        {detail && <p className="text-sm text-muted-foreground">{detail}</p>}
        {children}
      </div>
    </div>
  )
}

/** The name the member used last time, in a pool or a cluster, so that the next one knows them too. */
function useRememberedName(): [string, (name: string) => void, () => void] {
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const remember = () => {
    try {
      if (name.trim()) localStorage.setItem(NAME_KEY, name.trim())
    } catch {}
  }
  return [name, setName, remember]
}

export function NewCluster() {
  const store = useStore()
  const [name, setName] = useState('')
  const [about, setAbout] = useState('')
  const [you, setYou, rememberYou] = useRememberedName()
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!store.clusters || !name.trim()) return
    setBusy(true)
    rememberYou()
    const id = await store.clusters.create(
      { name: name.trim(), ...(about.trim() ? { about: about.trim() } : {}) },
      you.trim() ? { name: you.trim() } : undefined,
    )
    setBusy(false)
    if (id) store.showCluster({ kind: 'cluster', id }, 'members')
  }
  return (
    <FormPage
      title="New cluster"
      detail="A cluster lets the Claude Code and OpenCode sessions of several people tell each other what they do, ask, and hold files. Nobody drives anyone else's Claude."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name">
          <Input value={name} onChange={event => setName(event.target.value)} placeholder="Game jam" required maxLength={120} />
        </Field>
        <Field label="What it is for">
          <Textarea rows={2} value={about} onChange={event => setAbout(event.target.value)} placeholder="One sentence, optional" />
        </Field>
        <Field label="Your name">
          <Input value={you} onChange={event => setYou(event.target.value)} placeholder="How the others see you" />
        </Field>
        {store.clusters?.problem && <Problem>{store.clusters.problem}</Problem>}
        <div>
          <Button type="submit" disabled={busy || !name.trim()}>
            Create the cluster
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Its key is made in this browser: the relay never sees what the cluster says.</p>
      </form>
    </FormPage>
  )
}

export function JoinCluster({ invite }: { invite?: string }) {
  const store = useStore()
  const [text, setText] = useState(invite ?? '')
  const [you, setYou, rememberYou] = useRememberedName()
  const [busy, setBusy] = useState(false)
  const parsed = parseClusterInvite(text)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!store.clusters) return
    setBusy(true)
    rememberYou()
    const id = await store.clusters.join(text, you.trim() ? { name: you.trim() } : undefined)
    setBusy(false)
    if (id) store.showCluster({ kind: 'cluster', id })
  }
  return (
    <FormPage
      title="Join a cluster"
      detail="Then put your sessions in from the Roster tab, one by one, and choose how each takes the posts."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {invite && parsed ? (
          <p className="rounded-lg bg-secondary px-3 py-2 text-sm">
            Invite to a cluster on <strong>{new URL(parsed.relay).host}</strong>
          </p>
        ) : (
          <Field label="Invite">
            <Textarea
              rows={3}
              spellCheck={false}
              value={text}
              onChange={event => setText(event.target.value)}
              placeholder="The link someone sent you"
              className="font-mono text-xs"
            />
          </Field>
        )}
        <Field label="Your name">
          <Input value={you} onChange={event => setYou(event.target.value)} placeholder="How the others see you" />
        </Field>
        {store.clusters?.problem && <Problem>{store.clusters.problem}</Problem>}
        <div>
          <Button type="submit" disabled={busy || !parsed}>
            Join the cluster
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">The invite holds the cluster key: it stays in this browser.</p>
      </form>
    </FormPage>
  )
}
