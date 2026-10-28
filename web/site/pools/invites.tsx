// The open invites of a pool, a new one, and one QR code for the whole team of a hackathon. An invite holds the pool
// key: it is shown once, here, and the relay keeps only a hash of its token.
import { CopyIcon, PlusIcon, QrCodeIcon } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { countdown, type InviteSummary, invitableRoles, type PoolRole, qrCode } from '../../../shared'
import { Empty, Loading, Toolbar } from '../common'
import { plural } from '../format'
import { useStore } from '../store'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTrigger } from '../ui/dialog'
import { Field, Textarea } from '../ui/fields'
import { NativeSelect } from '../ui/select'
import type { TabProps } from './page'
import { roleLabel } from './roles'

export function Invites({ pool, state }: TabProps) {
  const store = useStore()
  const watch = store.pools
  const [invites, setInvites] = useState<InviteSummary[] | null>(null)
  const reload = useCallback(() => {
    void watch?.invites(pool.id).then(found => setInvites(found ?? []))
  }, [watch, pool.id])
  useEffect(reload, [reload])
  return (
    <div className="flex flex-col gap-4">
      <Toolbar title="Invites">
        <TeamQr poolId={pool.id} deadline={state.info?.deadline} onMade={reload} />
        <NewInvite poolId={pool.id} role={pool.role} onMade={reload} />
      </Toolbar>
      {invites === null ? (
        <Loading>Loading the invites…</Loading>
      ) : invites.length ? (
        <div className="flex flex-col divide-y rounded-lg border">
          {invites.map(invite => (
            <div key={invite.id} className="flex items-center gap-2 p-3">
              <span className="flex min-w-0 flex-1 flex-col">
                <strong className="font-medium">
                  {roleLabel(invite.role)} · {plural(invite.usesLeft, 'use')} left
                </strong>
                <small className="text-xs text-muted-foreground">Until {new Date(invite.expiresAt).toLocaleString()}</small>
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  if (await watch?.revokeInvite(pool.id, invite.id)) reload()
                }}
              >
                Revoke
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <Empty className="py-2 text-left">No open invite.</Empty>
      )}
      <p className="text-xs text-muted-foreground">
        Removing a member gives the pool a new key and revokes every open invite. {plural(state.members.length, 'member')} now.
      </p>
    </div>
  )
}

function NewInvite({ poolId, role, onMade }: { poolId: string; role: PoolRole; onMade(): void }) {
  const watch = useStore().pools
  const [open, setOpen] = useState(false)
  const [uses, setUses] = useState('1')
  const [hours, setHours] = useState('24')
  const [joinsAs, setJoinsAs] = useState<Exclude<PoolRole, 'owner'>>('member')
  const [link, setLink] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    const made = await watch?.invite(poolId, { uses: Number(uses), hours: Number(hours), role: joinsAs })
    setBusy(false)
    if (!made) return
    setLink(made.link)
    onMade()
  }
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        setOpen(next)
        if (!next) setLink(null)
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <PlusIcon />
          New invite
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader
          title="New invite"
          description="The invite holds the pool key: send it to people you trust, and revoke it once they joined."
        />
        {link ? (
          <InviteResult link={link} />
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Field label="Uses">
              <NativeSelect value={uses} onChange={event => setUses(event.target.value)} className="h-9">
                <option value="1">Once</option>
                <option value="5">5 times</option>
                <option value="20">20 times</option>
                <option value="100">100 times</option>
              </NativeSelect>
            </Field>
            <Field label="Valid for">
              <NativeSelect value={hours} onChange={event => setHours(event.target.value)} className="h-9">
                <option value="1">1 hour</option>
                <option value="24">1 day</option>
                <option value="168">1 week</option>
                <option value="720">30 days</option>
              </NativeSelect>
            </Field>
            <Field label="Joins as">
              <NativeSelect
                value={joinsAs}
                onChange={event => setJoinsAs(event.target.value as Exclude<PoolRole, 'owner'>)}
                className="h-9"
              >
                {invitableRoles(role).map(value => (
                  <option key={value} value={value}>
                    {roleLabel(value)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <DialogFooter>
              <Button type="submit" disabled={busy}>
                Create the invite
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * One invite every machine of the team joins with: up to 100 uses, as members, until the deadline (a day without one).
 * Made when the dialog opens; the QR code shows on the screen for everyone to scan.
 */
function TeamQr({ poolId, deadline, onMade }: { poolId: string; deadline?: string; onMade(): void }) {
  const store = useStore()
  const watch = store.pools
  const [link, setLink] = useState<string | null | undefined>(undefined)
  const [shown, setShown] = useState(false)
  const make = async () => {
    setLink(undefined)
    const left = countdown(deadline)?.left ?? 0
    const hours = left > 0 ? Math.min(720, Math.max(1, Math.ceil(left / 3_600_000))) : 24
    const made = await watch?.invite(poolId, { uses: 100, hours, role: 'member' })
    setLink(made?.link ?? null)
    onMade()
  }
  const show = (next: boolean) => {
    setShown(next)
    if (next) void make()
  }
  // A hackathon just made opens here on its QR code, for the team to scan.
  const first = useRef(true)
  useEffect(() => {
    if (!first.current) return
    first.current = false
    if (store.teamQrFor !== poolId) return
    store.teamQrFor = null
    show(true)
  })
  return (
    <Dialog open={shown} onOpenChange={show}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" title="An invite for up to 100 machines, valid until the deadline or for a day">
          <QrCodeIcon />
          One QR for the team
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader
          title="Join the team"
          description="Scan it from the web app on each machine, then put its sessions in the pool from the notch."
        />
        {link === undefined ? (
          <Loading>Making the invite…</Loading>
        ) : link ? (
          <InviteResult link={link} />
        ) : (
          <p>The invite could not be made.</p>
        )}
      </DialogContent>
    </Dialog>
  )
}

function InviteResult({ link }: { link: string }) {
  const [copied, setCopied] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  return (
    <div className="flex flex-col gap-3">
      <Textarea ref={field} readOnly rows={3} spellCheck={false} value={link} className="font-mono text-xs" />
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(link)
              setCopied(true)
            } catch {
              field.current?.select()
            }
          }}
        >
          <CopyIcon />
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <QrCanvas text={link} />
      <p className="text-xs text-muted-foreground">Scan it from the web app on a phone, or paste it in Join.</p>
    </div>
  )
}

/** The invite as a QR code: dark on white whatever the theme, with its quiet zone, as scanners expect. */
function QrCanvas({ text }: { text: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => {
    const code = qrCode(text)
    const node = canvas.current
    const context = node?.getContext('2d')
    if (!code || !node || !context) return
    const scale = 4
    const side = (code.size + 8) * scale
    node.width = side
    node.height = side
    context.fillStyle = '#fff'
    context.fillRect(0, 0, side, side)
    context.fillStyle = '#000'
    code.modules.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) context.fillRect((x + 4) * scale, (y + 4) * scale, scale, scale)
      })
    })
  }, [text])
  return <canvas ref={canvas} role="img" aria-label="QR code of the invite" className="self-center rounded-md" />
}
