// Signing in: the recovery key of the Mac app (Settings › Relay), pasted or scanned from the QR code of Settings ›
// Machines, or a teammate's read-only share key. The key stays in this browser.
import { CameraIcon, KeyRoundIcon } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { parseAccountToken, parseRecoveryKey, parseShareLink } from '../../shared'
import { cameraProblem, canScan, type Scan, startScan } from '../scanner'
import { Problem } from './common'
import { useStore } from './store'
import { Button } from './ui/button'
import { Card } from './ui/card'
import { cn } from './ui/cn'
import { Textarea } from './ui/fields'
import { Checkbox } from './ui/menu'

/** What the site holds, as colored tags in the headline. */
const TAGS = [
  { label: 'sessions', className: 'border-[var(--aura-orange)]/60 text-[var(--aura-orange)]' },
  { label: 'pools', className: 'border-[var(--aura-pink)]/60 text-[var(--aura-pink)]' },
  { label: 'machines', className: 'border-[var(--aura-blue)] text-[#6b83e6]' },
  { label: 'plans', className: 'border-[var(--aura-sun)] text-[#c99400]' },
]

export function SignIn() {
  const store = useStore()
  const [text, setText] = useState('')
  const [remember, setRemember] = useState(true)
  const [problem, setProblem] = useState<string | null>(store.signInProblem)
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState(false)
  const pendingInvite = store.poolView?.kind === 'join' && store.poolView.invite

  const submit = async (value: string) => {
    setBusy(true)
    try {
      setProblem(await store.signIn(value, remember))
    } catch {
      setProblem('This key could not be opened in this browser.')
    } finally {
      setBusy(false)
    }
  }
  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    void submit(text)
  }

  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-10 px-4 py-12">
      <div className="flex max-w-3xl flex-col items-center gap-6 text-center">
        <h1 className="font-serif text-5xl leading-[1.02] font-normal tracking-tight text-balance sm:text-7xl">
          Every Claude you run.
          <br />
          In one calm place.
        </h1>
        <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-2 text-lg text-muted-foreground">
          Your
          {TAGS.map(tag => (
            <span key={tag.label} className={cn('rounded-full border px-3 py-0.5 text-base', tag.className)}>
              {tag.label}
            </span>
          ))}
          from every machine, sealed end to end.
        </p>
      </div>
      <Card className="w-full max-w-md p-6">
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <KeyRoundIcon className="size-5 text-primary" />
            <h2 className="font-serif text-xl tracking-tight">Sign in</h2>
          </div>
          <p className="text-muted-foreground">
            Paste the recovery key of your account, from the Mac app: Settings › Relay › Recovery key, or scan its QR code in Settings ›
            Machines. Or the read-only share key a teammate sent you.
          </p>
          {pendingInvite && <p className="text-sm">Sign in first: the pool invite opens after.</p>}
          {scanning ? (
            <Scanner
              onCode={code => {
                setScanning(false)
                setText(code)
                void submit(code)
              }}
              onCancel={() => setScanning(false)}
              onProblem={message => {
                setScanning(false)
                setProblem(message)
              }}
            />
          ) : (
            <Textarea
              autoFocus
              value={text}
              onChange={event => setText(event.target.value)}
              placeholder="tonton1.… or tontonshare1.…"
              spellCheck={false}
              autoComplete="off"
              className="min-h-24 font-mono text-xs"
              aria-label="Recovery key or share key"
            />
          )}
          <span className="flex items-center gap-2">
            <Checkbox id="remember" checked={remember} onCheckedChange={value => setRemember(value === true)} />
            <label htmlFor="remember">Remember on this device</label>
          </span>
          {problem && <Problem>{problem}</Problem>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || !text.trim()}>
              Sign in
            </Button>
            {canScan() && !scanning && (
              <Button type="button" variant="outline" onClick={() => setScanning(true)}>
                <CameraIcon />
                Scan the QR code
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Whoever has this key can read and drive your sessions. It stays in this browser and never goes to the relay.
          </p>
        </form>
      </Card>
    </main>
  )
}

/** The camera, until it reads a code that holds a key. The camera stops as soon as it is done or cancelled. */
function Scanner({ onCode, onCancel, onProblem }: { onCode(text: string): void; onCancel(): void; onProblem(message: string): void }) {
  const video = useRef<HTMLVideoElement>(null)
  const [hint, setHint] = useState('Point the camera at the QR code in the Mac app: Settings › Machines › Phone or browser.')
  // The latest callbacks, for a scan that started earlier.
  const handlers = useRef({ onCode, onProblem })
  handlers.current = { onCode, onProblem }

  useEffect(() => {
    let scan: Scan | null = null
    let stopped = false
    const target = video.current
    if (!target) return
    startScan(target, text => {
      if (!parseRecoveryKey(text) && !parseShareLink(text)) {
        setHint(
          parseAccountToken(text)
            ? 'This is the token machines join with. Scan the code under Settings › Machines › Phone or browser.'
            : 'This QR code is not a Tonton Claude key.',
        )
        return false
      }
      handlers.current.onCode(text)
      return true
    })
      .then(started => {
        if (stopped) started.stop()
        else scan = started
      })
      .catch(problem => {
        if (!stopped) handlers.current.onProblem(cameraProblem(problem))
      })
    return () => {
      stopped = true
      scan?.stop()
    }
  }, [])

  return (
    <div className="flex flex-col items-start gap-2">
      <video ref={video} className="aspect-square w-full rounded-lg bg-black object-cover" muted playsInline />
      <p className="text-sm text-muted-foreground">{hint}</p>
      <Button type="button" variant="outline" size="sm" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  )
}
