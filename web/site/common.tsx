// Pieces every page uses: a session's status dot, what Claude wrote, and the notes that say something is on its way or
// went wrong. Text from sessions, tools and other members only ever goes in as text: web/markdown.ts builds the
// Markdown with DOM nodes, never HTML.
import { Loader2Icon } from 'lucide-react'
import { type ReactNode, useLayoutEffect, useRef } from 'react'
import { STATUS_LABELS } from '../../shared'
import type { SessionStatus } from '../../shared/protocol'
import { inline, renderMarkdown } from '../markdown'
import { cn } from './ui/cn'

const DOT_COLORS: Record<SessionStatus, string> = {
  starting: 'bg-primary',
  working: 'bg-primary',
  idle: 'bg-success',
  waiting: 'bg-warning',
  permission: 'bg-orange',
  error: 'bg-destructive',
  ended: 'bg-faint',
  offline: 'bg-faint',
}

export function StatusDot({ status, className }: { status: SessionStatus | null; className?: string }) {
  return (
    <span
      title={status ? STATUS_LABELS[status] : undefined}
      className={cn('inline-block size-2 shrink-0 rounded-full', status ? DOT_COLORS[status] : 'bg-faint', className)}
    />
  )
}

/** Markdown as web/markdown.ts renders it: elements and text nodes, nothing parsed as HTML. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    ref.current?.replaceChildren(renderMarkdown(text))
  }, [text])
  return <div ref={ref} className={cn('prose-chat break-words', className)} />
}

/** Code, bold, italics and links in a line, the rest as plain text with its line breaks. */
export function InlineText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    ref.current?.replaceChildren(...inline(text))
  }, [text])
  return <span ref={ref} className={cn('prose-chat whitespace-pre-wrap break-words', className)} />
}

export function Loading({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
      <Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" />
      {children}
    </p>
  )
}

export function Empty({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('py-6 text-center text-sm text-muted-foreground', className)}>{children}</p>
}

export function Problem({ children, onDismiss }: { children: ReactNode; onDismiss?: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm">
      <span className="flex-1 text-destructive">{children}</span>
      {onDismiss && (
        <button type="button" className="text-xs underline" onClick={onDismiss}>
          OK
        </button>
      )}
    </div>
  )
}

/** A page's title row: a name, what it is, and its actions. */
export function Toolbar({ title, detail, children }: { title: ReactNode; detail?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight">
        <span className="icon-tile size-2.5" />
        {title}
      </h2>
      {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
      <div className="ms-auto flex flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}
