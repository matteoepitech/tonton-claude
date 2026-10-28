// Making a pool, from scratch or as a hackathon (a deadline, the repository, the roles and one QR code for the team), and
// joining one with an invite.
import { ArrowLeftIcon } from 'lucide-react'
import { type FormEvent, type ReactNode, useState } from 'react'
import { HACKATHON_ROLES, hackathonInfo, hackathonNotes, hackathonRoleLabel } from '../../../shared'
import { Problem } from '../common'
import { localInput } from '../format'
import { useStore } from '../store'
import { Button } from '../ui/button'
import { Field, Input, Textarea } from '../ui/fields'
import { Checkbox } from '../ui/menu'

function FormPage({ title, children }: { title: string; children: ReactNode }) {
  const store = useStore()
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={() => store.showPool(null)} aria-label="Back to the pools">
          <ArrowLeftIcon />
        </Button>
        <strong>{title}</strong>
      </div>
      <div className="w-full max-w-xl p-4">{children}</div>
    </div>
  )
}

export function NewPool() {
  const store = useStore()
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [you, setYou] = useState('')
  const [hackathon, setHackathon] = useState(false)
  const [deadline, setDeadline] = useState(() => localInput(new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 24 * 3_600_000)))
  const [repo, setRepo] = useState('')
  const [roles, setRoles] = useState<string[]>([...HACKATHON_ROLES])
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const watch = store.pools
    if (!watch || !name.trim()) return
    const info = { name: name.trim(), ...(goal.trim() ? { goal: goal.trim() } : {}) }
    let setup = null
    if (hackathon) {
      const end = new Date(deadline)
      if (Number.isNaN(end.getTime()) || end.getTime() <= Date.now()) return setProblem('Give the hackathon a deadline in the future.')
      setup = { deadline: end.toISOString(), repo: repo.trim(), roles }
    }
    setBusy(true)
    const id = await watch.create(
      setup ? hackathonInfo(info, setup) : info,
      you.trim() ? { name: you.trim() } : undefined,
      setup ? hackathonNotes(setup) : undefined,
    )
    setBusy(false)
    // A hackathon opens on its invites, for the team's QR code.
    if (!id) return
    if (setup) store.teamQrFor = id
    store.showPool({ kind: 'pool', id }, setup ? 'invites' : undefined)
  }

  return (
    <FormPage title="New pool">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name">
          <Input required value={name} onChange={event => setName(event.target.value)} placeholder="Basel Hack" />
        </Field>
        <Field label="Goal">
          <Textarea
            rows={3}
            value={goal}
            onChange={event => setGoal(event.target.value)}
            placeholder="What the pool builds: the app, its stack, the deadline"
          />
        </Field>
        <Field label="You">
          <Input value={you} onChange={event => setYou(event.target.value)} placeholder="Your name in the pool" />
        </Field>
        <span className="flex items-center gap-2">
          <Checkbox id="hackathon" checked={hackathon} onCheckedChange={value => setHackathon(value === true)} />
          <label htmlFor="hackathon">Hackathon: a deadline, roles and one QR code for the team</label>
        </span>
        {hackathon && (
          <div className="flex flex-col gap-4 rounded-lg border p-3">
            <Field label="Deadline">
              <Input type="datetime-local" value={deadline} onChange={event => setDeadline(event.target.value)} />
            </Field>
            <Field label="Repository">
              <Input value={repo} onChange={event => setRepo(event.target.value)} placeholder="https://github.com/team/app" />
            </Field>
            <fieldset className="flex flex-wrap gap-4">
              <legend className="mb-1.5 text-xs font-medium text-muted-foreground">Roles</legend>
              {HACKATHON_ROLES.map(role => (
                <span key={role} className="flex items-center gap-2">
                  <Checkbox
                    id={`role-${role}`}
                    checked={roles.includes(role)}
                    onCheckedChange={value => setRoles(value === true ? [...roles, role] : roles.filter(r => r !== role))}
                  />
                  <label htmlFor={`role-${role}`}>{hackathonRoleLabel(role)}</label>
                </span>
              ))}
            </fieldset>
            <p className="text-xs text-muted-foreground">
              The orchestrator plans for the time left and hears at half time, one hour and fifteen minutes before the end. One QR code
              joins the team.
            </p>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          The pool gets its own key, made in this browser. The relay only keeps it sealed with your account key.
        </p>
        {problem && <Problem>{problem}</Problem>}
        <div>
          <Button type="submit" disabled={busy || !name.trim()}>
            Create
          </Button>
        </div>
      </form>
    </FormPage>
  )
}

export function JoinPool({ invite }: { invite?: string }) {
  const store = useStore()
  const [text, setText] = useState(invite ?? '')
  const [you, setYou] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!store.pools) return
    setBusy(true)
    const id = await store.pools.join(text, you.trim() ? { name: you.trim() } : undefined)
    setBusy(false)
    if (id) store.showPool({ kind: 'pool', id })
  }
  return (
    <FormPage title="Join a pool">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Invite">
          <Textarea
            rows={4}
            spellCheck={false}
            value={text}
            onChange={event => setText(event.target.value)}
            placeholder="tontonpool1.…"
            className="font-mono text-xs"
          />
        </Field>
        <Field label="You">
          <Input value={you} onChange={event => setYou(event.target.value)} placeholder="Your name in the pool" />
        </Field>
        <p className="text-xs text-muted-foreground">
          Whoever sent it sees you join. The invite holds the pool key: it stays in this browser.
        </p>
        {store.pools?.problem && <Problem>{store.pools.problem}</Problem>}
        <div>
          <Button type="submit" disabled={busy || !text.trim()}>
            Join
          </Button>
        </div>
      </form>
    </FormPage>
  )
}
