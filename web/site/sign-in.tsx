// Signing in: the recovery key of the Mac app (Settings › Relay), pasted or scanned from the QR code of Settings ›
// Machines, or a teammate's read-only share key. The key stays in this browser.
import { ArrowRightIcon, CameraIcon } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { parseAccountToken, parseRecoveryKey, parseShareLink } from '../../shared'
import { cameraProblem, canScan, type Scan, startScan } from '../scanner'
import { Problem } from './common'
import { PixelLogo } from './logo'
import { Mosaic } from './mosaic'
import { useStore } from './store'
import { Button } from './ui/button'
import { Input } from './ui/fields'

export function SignIn() {
  const store = useStore()
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<string | null>(store.signInProblem)
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState(false)

  // The key is remembered in this browser, as a key no script can read back (store.ts).
  const submit = async (value: string) => {
    setBusy(true)
    try {
      setProblem(await store.signIn(value, true))
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
    // A white column framed by dashed rules: the dots show on either side, never under the text.
    <main className="flex min-h-full justify-center px-4 sm:px-10">
      <div className="rule-dashed relative flex w-full max-w-4xl flex-col items-center justify-center gap-10 border-x bg-white px-4 py-16">
        <Mosaic className="absolute top-0 left-0" />
        <Mosaic className="absolute right-0 bottom-0 rotate-180" />
        <PixelLogo className="size-10" />
        <h1 className="max-w-3xl text-center text-5xl leading-[1.05] font-bold tracking-tight text-balance sm:text-7xl">
          Every Claude you run, in one place
        </h1>
        <form onSubmit={onSubmit} className="flex w-full max-w-lg flex-col gap-3">
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
            <div className="raised flex items-center gap-1.5 rounded-lg border bg-white p-1.5">
              <Input
                autoFocus
                value={text}
                onChange={event => setText(event.target.value)}
                placeholder="Paste your recovery key"
                spellCheck={false}
                autoComplete="off"
                className="h-10 border-0 bg-transparent font-mono text-sm focus-visible:ring-0"
                aria-label="Recovery key or share key"
                title="From the Mac app: Settings › Relay › Recovery key. A teammate's share key works too."
              />
              {canScan() && (
                <Button type="button" variant="ghost" size="icon" onClick={() => setScanning(true)} aria-label="Scan the QR code">
                  <CameraIcon />
                </Button>
              )}
              <Button type="submit" size="icon" className="size-10" disabled={busy || !text.trim()} aria-label="Sign in">
                <ArrowRightIcon />
              </Button>
            </div>
          )}
          {problem && <Problem>{problem}</Problem>}
        </form>
      </div>
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
