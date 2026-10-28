// Inviting teammates: one click makes a link and its QR code; another kind of invite (once, an admin, a viewer) is a step
// further; the open invites are listed with Revoke. An invite holds the pool key: it is shown once, here, and the relay
// keeps only a hash of its token.
import { CopyIcon, UserPlusIcon } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { countdown, type InviteSummary, invitableRoles, type PoolRole, qrCode } from '../../../shared'
import { Loading } from '../common'
import { plural } from '../format'
import { useStore } from '../store'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTrigger } from '../ui/dialog'
import { Field, Textarea } from '../ui/fields'
import { NativeSelect } from '../ui/select'
import type { TabProps } from './page'
import { roleLabel } from './roles'

/**
 * Invite teammates in one click: the link (with its QR code) is made as the dialog opens, for up to 20 people over a week,
 * or until a hackathon's deadline, as members. Another kind of invite is under Other invite.
 */
export function InviteButton({ pool, state, variant = 'default' }: TabProps & { variant?: 'default' | 'outline' }) {
  const watch = useStore().pools
  const [link, setLink] = useState<string | null | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const make = async () => {
    setLink(undefined)
    const left = countdown(state.info?.deadline)?.left ?? 0
    const hours = left > 0 ? Math.min(720, Math.max(1, Math.ceil(left / 3_600_000))) : 168
    const made = await watch?.invite(pool.id, { uses: 20, hours, role: 'member' })
    setLink(made?.link ?? null)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        setOpen(next)
        if (next) void make()
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant={variant}>
          <UserPlusIcon />
          Invite
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader
          title="Invite your team"
          description="Send them this link, or let them scan the code. Their machines join with them and say what they bring."
        />
        {link === undefined ? (
          <Loading>Making the invite…</Loading>
        ) : link ? (
          <InviteResult link={link} />
        ) : (
          <p className="text-sm">The invite could not be made: {watch?.problem ?? 'try again in a moment.'}</p>
        )}
        <p className="text-xs text-muted-foreground">
          Up to 20 people, {state.info?.deadline ? 'until the deadline' : 'for a week'}, as members. It holds the pool key: send it to
          people you trust.
        </p>
        <NewInvite poolId={pool.id} role={pool.role} onMade={() => {}} />
      </DialogContent>
    </Dialog>
  )
}

/** The invites still open, for the owner and admins, with Revoke. */
export function OpenInvites({ pool }: TabProps) {
  const watch = useStore().pools
  const [invites, setInvites] = useState<InviteSummary[] | null>(null)
  const reload = useCallback(() => {
    void watch?.invites(pool.id).then(found => setInvites(found ?? []))
  }, [watch, pool.id])
  useEffect(reload, [reload])
  if (!invites?.length) return null
  return (
    <details className="rounded-lg border">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{plural(invites.length, 'open invite')}</summary>
      <div className="flex flex-col divide-y border-t">
        {invites.map(invite => (
          <div key={invite.id} className="flex items-center gap-2 px-3 py-2">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm">
                {roleLabel(invite.role)} · {plural(invite.usesLeft, 'use')} left
              </span>
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
      <p className="border-t px-3 py-2 text-xs text-muted-foreground">
        Removing a member gives the pool a new key and revokes every open invite.
      </p>
    </details>
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
        <Button variant="link" size="sm" className="h-auto self-start p-0">
          Other invite: once, as an admin or a viewer…
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
      <p className="text-xs text-muted-foreground">Opening the link joins the pool on this relay's website.</p>
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
