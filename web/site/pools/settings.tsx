// A pool's settings: its name, goal and repository (and a hackathon's deadline), what the relay sees of it, leaving it
// and deleting it.
import { type FormEvent, useState } from 'react'
import { type PoolInfo, poolAbilities } from '../../../shared'
import { Toolbar } from '../common'
import { localInput } from '../format'
import { useStore } from '../store'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { Confirm, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTrigger } from '../ui/dialog'
import { Field, Input, Textarea } from '../ui/fields'
import type { TabProps } from './page'

export function Settings({ pool, state }: TabProps) {
  const store = useStore()
  const can = poolAbilities(pool.role)
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <Toolbar title="Settings">{can.editInfo && <InfoDialog poolId={pool.id} info={state.info} />}</Toolbar>
      <Card className="p-4 text-sm text-muted-foreground">
        Key version {state.keyVersion}. Created {new Date(state.createdAt).toLocaleDateString()}. Everything the pool says is sealed with
        its key; the relay sees ids, roles, sizes and times.
      </Card>
      <div className="flex flex-wrap gap-2">
        {can.leave && (
          <Confirm
            trigger={
              <Button variant="outline" className="text-destructive">
                Leave the pool
              </Button>
            }
            title="Leave the pool?"
            description="Your sessions leave it with you."
            action="Leave"
            onConfirm={() => void store.pools?.leave(pool.id).then(() => store.showPool(null))}
          />
        )}
        {can.remove && (
          <Confirm
            trigger={<Button variant="destructive">Delete the pool</Button>}
            title="Delete the pool for everyone?"
            description="Its tasks, notes and messages go with it."
            action="Delete"
            onConfirm={() => void store.pools?.remove(pool.id).then(() => store.showPool(null))}
          />
        )}
      </div>
    </div>
  )
}

function InfoDialog({ poolId, info }: { poolId: string; info: PoolInfo | null }) {
  const store = useStore()
  const hackathon = info?.template === 'hackathon'
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [deadline, setDeadline] = useState('')
  const [repo, setRepo] = useState('')
  const reset = () => {
    setName(info?.name ?? '')
    setGoal(info?.goal ?? '')
    setDeadline(info?.deadline ? localInput(new Date(info.deadline)) : '')
    setRepo(info?.repo ?? '')
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    // The rest of the info, such as a hackathon's, stays as it was.
    const next: PoolInfo = { ...info, name: name.trim(), goal: goal.trim() || undefined }
    // The repository the machines clone: every pool has one.
    next.repo = repo.trim() || undefined
    if (hackathon) {
      const end = new Date(deadline)
      if (!Number.isNaN(end.getTime())) next.deadline = end.toISOString()
    }
    if (await store.pools?.updateInfo(poolId, JSON.parse(JSON.stringify(next)))) setOpen(false)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (next) reset()
        setOpen(next)
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Change the name and repository
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader title="The pool" />
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Name">
            <Input value={name} onChange={event => setName(event.target.value)} />
          </Field>
          <Field label="Goal">
            <Textarea rows={3} value={goal} onChange={event => setGoal(event.target.value)} />
          </Field>
          <Field label="Repository">
            <Input value={repo} onChange={event => setRepo(event.target.value)} placeholder="https://github.com/team/app or git@…" />
          </Field>
          {hackathon && (
            <Field label="Deadline">
              <Input type="datetime-local" value={deadline} onChange={event => setDeadline(event.target.value)} />
            </Field>
          )}
          <DialogFooter>
            <Button type="submit" disabled={!name.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
