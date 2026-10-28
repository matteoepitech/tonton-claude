// Making a pool and joining one, each on one screen: what the pool is, who you are in it, and the machines of the account
// that come with you. A machine's profile is worked out from what its agent reports (its plan, its tools, its memory),
// so nothing is asked about it; only whether its sessions may run commands without asking stays its owner's to say.
import { ArrowLeftIcon, CpuIcon } from 'lucide-react'
import { type FormEvent, type ReactNode, useMemo, useState } from 'react'
import {
  HACKATHON_ROLES,
  hackathonInfo,
  hackathonNotes,
  type MachinePick,
  machinePlanLabel,
  machinesToAdd,
  type PoolMachineMode,
  parsePoolInvite,
} from '../../../shared'
import { Problem } from '../common'
import { localInput, plural } from '../format'
import { useStore } from '../store'
import { Button } from '../ui/button'
import { Field, Input, Textarea } from '../ui/fields'
import { Checkbox } from '../ui/menu'

const NAME_KEY = 'tonton.poolName'

function FormPage({ title, detail, children }: { title: string; detail?: string; children: ReactNode }) {
  const store = useStore()
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={() => store.showPool(null)} aria-label="Back to the pools">
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

/** The name the member used last time, so that the next pool knows them too. */
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

/** The account's machines that come with the member, each with what it brings; online ones are ticked. */
function useMachinePicks(pool: { id: string; name?: string }) {
  const store = useStore()
  const [full, setFull] = useState(false)
  // What the member ticked or unticked; the others follow whether the machine is online.
  const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(new Map())
  const mode: PoolMachineMode = full ? 'full' : 'edits'
  const machines = store.state?.machines
  const picks = useMemo(() => machinesToAdd(machines ?? [], pool, mode), [machines, pool, mode])
  // An offline machine joins when ticked: it takes the order when it next connects.
  const ticked = (pick: MachinePick) => choices.get(pick.machine.id) ?? pick.machine.online
  const toggle = (pick: MachinePick, on: boolean) => setChoices(new Map(choices).set(pick.machine.id, on))
  return { picks, chosen: picks.filter(ticked), ticked, toggle, full, setFull }
}

function MachinePicker({ picks }: { picks: ReturnType<typeof useMachinePicks> }) {
  const store = useStore()
  if (!store.state) return null
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1.5 text-xs font-medium text-muted-foreground">Your machines</legend>
      {picks.picks.length ? (
        <div className="flex flex-col divide-y rounded-lg border">
          {picks.picks.map(pick => (
            <div key={pick.machine.id} className="flex items-center gap-3 px-3 py-2.5">
              <Checkbox
                id={`machine-${pick.machine.id}`}
                checked={picks.ticked(pick)}
                onCheckedChange={value => picks.toggle(pick, value === true)}
              />
              <CpuIcon className="size-4 shrink-0 text-muted-foreground" />
              <label htmlFor={`machine-${pick.machine.id}`} className="flex min-w-0 flex-1 cursor-pointer flex-col">
                <span className="truncate text-sm font-medium">{pick.machine.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {machinePlanLabel(pick.profile)} · {plural(pick.profile.capacity, 'session')} at once
                  {pick.machine.online ? '' : ' · offline, joins when it connects'}
                </span>
              </label>
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
          No machine of this account can work for a pool yet: install the agent (version 0.9 or later) on one, then add it from the pool's
          Team tab.
        </p>
      )}
      {picks.picks.length > 0 && (
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <Checkbox id="machines-full" className="mt-0.5" checked={picks.full} onCheckedChange={value => picks.setFull(value === true)} />
          <label htmlFor="machines-full" className="cursor-pointer">
            Let their sessions run commands without asking (tests, git push). Only for machines you give to the pool: otherwise each command
            waits for you in the notch.
          </label>
        </div>
      )}
    </fieldset>
  )
}

export function NewPool() {
  const store = useStore()
  const [name, setName] = useState('')
  const [repo, setRepo] = useState('')
  const [you, setYou, rememberYou] = useRememberedName()
  const [hackathon, setHackathon] = useState(false)
  const [deadline, setDeadline] = useState(() => localInput(new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 24 * 3_600_000)))
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The pool id is only known once made: the folders are named after the pool's name until then.
  const draft = useMemo(() => ({ id: 'newpool', name: name.trim() }), [name])
  const picks = useMachinePicks(draft)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const watch = store.pools
    if (!watch || !name.trim()) return
    const info = { name: name.trim(), ...(repo.trim() ? { repo: repo.trim() } : {}) }
    let setup = null
    if (hackathon) {
      const end = new Date(deadline)
      if (Number.isNaN(end.getTime()) || end.getTime() <= Date.now()) return setProblem('Give the hackathon a deadline in the future.')
      setup = { deadline: end.toISOString(), repo: repo.trim(), roles: [...HACKATHON_ROLES] }
    }
    setBusy(true)
    rememberYou()
    const id = await watch.create(
      setup ? hackathonInfo(info, setup) : info,
      you.trim() ? { name: you.trim() } : undefined,
      setup ? hackathonNotes(setup) : undefined,
    )
    setBusy(false)
    if (!id) return
    store.showPool({ kind: 'pool', id })
    const chosen = machinesToAdd(
      picks.chosen.map(pick => pick.machine),
      { id, name: info.name },
      picks.full ? 'full' : 'edits',
    )
    void store.bringMachines(id, chosen)
  }

  return (
    <FormPage
      title="New pool"
      detail="Your machines join it, and the best one runs the orchestrator. Then tell the orchestrator what to build: it proposes a plan, you accept it, and the machines get to work."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name">
          <Input required value={name} onChange={event => setName(event.target.value)} placeholder="Basel Hack" />
        </Field>
        <Field label="Repository">
          <Input value={repo} onChange={event => setRepo(event.target.value)} placeholder="https://github.com/team/app or git@…" />
        </Field>
        <Field label="Your name">
          <Input value={you} onChange={event => setYou(event.target.value)} placeholder="How the team sees you" />
        </Field>
        <MachinePicker picks={picks} />
        <div className="flex items-center gap-2 text-sm">
          <Checkbox id="hackathon" checked={hackathon} onCheckedChange={value => setHackathon(value === true)} />
          <label htmlFor="hackathon" className="cursor-pointer">
            Hackathon: a deadline the orchestrator plans for
          </label>
        </div>
        {hackathon && (
          <Field label="Deadline">
            <Input type="datetime-local" value={deadline} onChange={event => setDeadline(event.target.value)} />
          </Field>
        )}
        {!repo.trim() && (
          <p className="text-xs text-muted-foreground">
            Without a repository, the machines have nothing to clone: add it now, or later in Settings.
          </p>
        )}
        {problem && <Problem>{problem}</Problem>}
        {store.pools?.problem && <Problem>{store.pools.problem}</Problem>}
        <div>
          <Button type="submit" disabled={busy || !name.trim()}>
            Create the pool
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          The pool gets its own key, made in this browser. The relay only keeps it sealed with your account key.
        </p>
      </form>
    </FormPage>
  )
}

export function JoinPool({ invite }: { invite?: string }) {
  const store = useStore()
  const [text, setText] = useState(invite ?? '')
  const [you, setYou, rememberYou] = useRememberedName()
  const [busy, setBusy] = useState(false)
  const parsed = parsePoolInvite(text)
  const draft = useMemo(() => ({ id: parsed?.pool ?? 'newpool' }), [parsed?.pool])
  const picks = useMachinePicks(draft)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!store.pools) return
    setBusy(true)
    rememberYou()
    const id = await store.pools.join(text, you.trim() ? { name: you.trim() } : undefined)
    setBusy(false)
    if (!id) return
    store.showPool({ kind: 'pool', id })
    const listed = store.pools.pools.find(pool => pool.summary.id === id)
    const chosen = machinesToAdd(
      picks.chosen.map(pick => pick.machine),
      { id, name: listed?.info?.name },
      picks.full ? 'full' : 'edits',
    )
    void store.bringMachines(id, chosen)
  }
  return (
    <FormPage
      title="Join a pool"
      detail="Your machines join with you and say what they bring: their Claude plan, how many sessions they run at once. The orchestrator hands them work from there."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {invite && parsed ? (
          <p className="rounded-lg bg-secondary px-3 py-2 text-sm">
            Invite to a pool on <strong>{new URL(parsed.relay).host}</strong>
          </p>
        ) : (
          <Field label="Invite">
            <Textarea
              rows={3}
              spellCheck={false}
              value={text}
              onChange={event => setText(event.target.value)}
              placeholder="The link a teammate sent you"
              className="font-mono text-xs"
            />
          </Field>
        )}
        <Field label="Your name">
          <Input value={you} onChange={event => setYou(event.target.value)} placeholder="How the team sees you" />
        </Field>
        <MachinePicker picks={picks} />
        {store.pools?.problem && <Problem>{store.pools.problem}</Problem>}
        <div>
          <Button type="submit" disabled={busy || !parsed}>
            Join the pool
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">The invite holds the pool key: it stays in this browser.</p>
      </form>
    </FormPage>
  )
}
