// A session's conversation: what Claude and the user wrote, the tool calls with their output and diffs, Claude's task
// list, the permission requests, and the box to write. Also the read-only view of a shared session, and the orchestrator
// chat of a pool, which is the same conversation.
import { ArrowLeftIcon, CheckIcon, CircleDashedIcon, CircleIcon, LoaderIcon, SendIcon, XIcon } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import {
  accepts,
  type ChatItem,
  type ClientState,
  changedFiles,
  chatItems,
  displayStatusText,
  type Entry,
  keepsSessionRules,
  latestTodos,
  type Machine,
  menuCommands,
  modelName,
  needsAttention,
  type RelayClient,
  type Session,
  STATUS_LABELS,
  sessionRuleFor,
  shownPath,
} from '../../../shared'
import type { SessionCommand, TodoItem } from '../../../shared/protocol'
import { InlineText, Loading, Markdown, StatusDot } from '../common'
import { Button } from '../ui/button'
import { cn } from '../ui/cn'
import { Confirm } from '../ui/dialog'
import { Textarea } from '../ui/fields'

/** What is being typed, per session: switching sessions or pages keeps it. */
const drafts = new Map<string, string>()

export function Chat({
  session,
  state,
  client,
  onBack,
  placeholder,
}: {
  session: Session
  state: ClientState
  client: RelayClient | null
  onBack?: () => void
  placeholder?: string
}) {
  const [showFiles, setShowFiles] = useState(false)
  const entries = state.selectedId === session.id ? state.entries : null
  const files = changedFiles(entries ?? [])
  const machine = state.machines.find(m => m.id === session.machineId)
  const todos = latestTodos(entries ?? [])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatHeader session={session} client={client} onBack={onBack}>
        {files.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => setShowFiles(!showFiles)} title="Files changed in this session">
            {showFiles ? 'Conversation' : `Files (${files.length})`}
          </Button>
        )}
      </ChatHeader>
      {showFiles ? (
        <ChangedFiles session={session} entries={entries ?? []} />
      ) : (
        <Conversation entries={entries} loadingEarlier={state.selectedId === session.id && state.loadingEarlier}>
          {session.pendingPermissions.map(request => (
            <PermissionCard key={request.requestId} session={session} request={request} machine={machine} client={client} />
          ))}
        </Conversation>
      )}
      {todos?.length ? <Checklist todos={todos} /> : null}
      <Composer session={session} client={client} placeholder={placeholder} />
    </div>
  )
}

export function ChatHeader({
  session,
  client,
  onBack,
  children,
}: {
  session: Session
  client: RelayClient | null
  onBack?: () => void
  children?: ReactNode
}) {
  const details = [
    session.machine,
    session.branch ? `⎇ ${session.branch}` : null,
    session.model ? modelName(session.model) : null,
    session.tool === 'opencode' ? 'OpenCode' : null,
  ]
  return (
    <div className="flex flex-wrap items-center gap-2.5 border-b px-4 py-2.5">
      {onBack && (
        <Button variant="ghost" size="icon" className="md:hidden" onClick={onBack} aria-label="Back to the sessions">
          <ArrowLeftIcon />
        </Button>
      )}
      <StatusDot status={session.status} />
      <span className="flex min-w-0 flex-col">
        <strong className="truncate font-medium">{session.name ?? session.project}</strong>
        <small className="truncate text-xs text-muted-foreground">{details.filter(Boolean).join(' · ')}</small>
      </span>
      <em className="ms-auto text-xs text-muted-foreground not-italic">
        {needsAttention(session.status) ? displayStatusText(session) : STATUS_LABELS[session.status]}
      </em>
      <Commands session={session} client={client} />
      {children}
    </div>
  )
}

/** Stop while it works; compact and clear while it waits. Only what its agent says it runs. */
function Commands({ session, client }: { session: Session; client: RelayClient | null }) {
  const names: SessionCommand['name'][] = [...(accepts(session, 'interrupt') ? (['interrupt'] as const) : []), ...menuCommands(session)]
  const labels: Record<string, string> = { interrupt: 'Stop', compact: 'Compact', clear: 'Clear' }
  return names.map(name =>
    name === 'clear' ? (
      <Confirm
        key={name}
        trigger={
          <Button variant="outline" size="sm" disabled={!accepts(session, name)}>
            Clear
          </Button>
        }
        title="Clear the conversation?"
        description="Claude starts over, without what was said so far."
        action="Clear"
        onConfirm={() => void client?.sendCommand(session.id, 'clear')}
      />
    ) : (
      <Button
        key={name}
        variant="outline"
        size="sm"
        disabled={!accepts(session, name)}
        onClick={() => void client?.sendCommand(session.id, name)}
      >
        {labels[name] ?? name}
      </Button>
    ),
  )
}

/** The messages, following the end while the user is there, left alone while they read further up. */
export function Conversation({
  entries,
  loadingEarlier = false,
  children,
}: {
  entries: readonly Entry[] | null
  loadingEarlier?: boolean
  children?: ReactNode
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)
  useLayoutEffect(() => {
    const node = scroller.current
    if (node && atEnd.current) node.scrollTop = node.scrollHeight
  })
  return (
    <div
      ref={scroller}
      onScroll={event => {
        const node = event.currentTarget
        atEnd.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40
      }}
      className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-4"
    >
      {!entries && <Loading>Loading the conversation…</Loading>}
      {entries && loadingEarlier && <Loading>Loading earlier messages…</Loading>}
      {chatItems(entries ?? []).map(item => (
        <Message key={item.id} item={item} />
      ))}
      {children}
    </div>
  )
}

function Message({ item }: { item: ChatItem }) {
  if (item.kind === 'user') {
    return (
      <div className="max-w-[85%] self-end rounded-2xl bg-primary px-3 py-2 text-primary-foreground">
        <InlineText text={item.entry.text} />
      </div>
    )
  }
  if (item.kind === 'assistant') return <Markdown text={item.entry.text} />
  if (item.kind === 'system') return <p className="text-center text-xs text-muted-foreground">{item.entry.text}</p>
  const running = !item.result
  const failed = item.result?.isError
  return (
    <details className="rounded-lg border bg-secondary px-2.5 py-1.5 text-[13px]">
      <summary className="cursor-pointer truncate text-muted-foreground">
        <strong className={cn('font-semibold text-foreground', failed && 'text-destructive', running && 'text-primary')}>
          {item.call.name}
        </strong>{' '}
        {item.call.summary}
      </summary>
      {item.result?.text && <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap font-mono text-xs">{item.result.text}</pre>}
      {item.call.edits?.map((edit, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a call's edits never move: their place is who they are.
        <Diff key={index} oldText={edit.oldText} newText={edit.newText} />
      ))}
    </details>
  )
}

function Diff({ oldText, newText }: { oldText: string; newText: string }) {
  return (
    <pre className="mt-2 overflow-x-auto font-mono text-xs whitespace-pre-wrap">
      <del className="block bg-destructive/15 text-destructive no-underline">{oldText}</del>
      <ins className="block bg-success/15 text-success no-underline">{newText}</ins>
    </pre>
  )
}

/** Each file Claude changed, the most recent first, with its diffs. */
function ChangedFiles({ session, entries }: { session: Session; entries: readonly Entry[] }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
      {changedFiles(entries).map(file => {
        const changes = file.changes
          ? `${file.changes} change${file.changes === 1 ? '' : 's'}${file.written && !file.edits.length ? ', written' : ''}`
          : 'failed'
        return (
          <details key={file.path} className="rounded-lg border bg-secondary px-2.5 py-1.5 text-[13px]">
            <summary className="cursor-pointer truncate text-muted-foreground">
              <strong className={cn('font-semibold text-foreground', file.lastFailed && 'text-destructive')}>{file.name}</strong>{' '}
              {shownPath(file.path, session.cwd)} · {changes}
              {file.lastFailed ? ' · the last change failed' : ''}
            </summary>
            {file.edits.map((edit, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a file's edits only grow at the end.
              <Diff key={index} oldText={edit.oldText} newText={edit.newText} />
            ))}
          </details>
        )
      })}
    </div>
  )
}

/** Claude's latest task list, above the box to write: a finished list starts folded. */
function Checklist({ todos }: { todos: TodoItem[] }) {
  const counted = todos.filter(todo => todo.status !== 'cancelled')
  const done = counted.filter(todo => todo.status === 'completed').length
  const marks = {
    completed: <CheckIcon className="size-3.5 text-success" />,
    in_progress: <LoaderIcon className="size-3.5 text-primary" />,
    cancelled: <XIcon className="size-3.5" />,
    pending: <CircleIcon className="size-3.5" />,
  }
  return (
    <details open={done < counted.length} className="mx-4 mb-2 rounded-lg border px-3 py-1.5 text-[13px]">
      <summary className="cursor-pointer text-muted-foreground">
        <strong className="text-foreground">Tasks</strong> {done === counted.length ? 'All done' : `${done}/${counted.length}`}
      </summary>
      <ul className="mt-1.5 flex flex-col gap-1">
        {todos.map((todo, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: Claude rewrites the list whole; two tasks may read the same.
            key={index}
            className={cn(
              'flex items-start gap-2',
              (todo.status === 'completed' || todo.status === 'cancelled') && 'text-muted-foreground line-through',
            )}
          >
            <span className="mt-0.5">{marks[todo.status] ?? <CircleDashedIcon className="size-3.5" />}</span>
            {todo.status === 'in_progress' ? (todo.activeForm ?? todo.content) : todo.content}
          </li>
        ))}
      </ul>
    </details>
  )
}

function PermissionCard({
  session,
  request,
  machine,
  client,
}: {
  session: Session
  request: Session['pendingPermissions'][number]
  machine: Machine | undefined
  client: RelayClient | null
}) {
  const rule = keepsSessionRules(machine) ? sessionRuleFor(request.toolName, request.inputPreview) : null
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-orange/40 bg-orange/10 p-3">
      <strong>{request.toolName} wants to run</strong>
      <pre className="max-h-60 overflow-auto rounded-md bg-background/60 p-2 font-mono text-xs whitespace-pre-wrap">
        {request.description}
      </pre>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => client?.answer(session.id, request.requestId, false)}>
          Deny
        </Button>
        {rule && (
          <Button
            variant="secondary"
            size="sm"
            title={`${rule.label}: calls like this one are allowed until the session ends.`}
            onClick={() => void client?.allowForSession(session.id, request.requestId, rule.rules)}
          >
            Allow for this session: {rule.label.length > 40 ? `${rule.label.slice(0, 40)}…` : rule.label}
          </Button>
        )}
        <Button size="sm" onClick={() => client?.answer(session.id, request.requestId, true)}>
          Allow
        </Button>
      </div>
    </div>
  )
}

function Composer({ session, client, placeholder }: { session: Session; client: RelayClient | null; placeholder?: string }) {
  const [text, setText] = useState(drafts.get(session.id) ?? '')
  const [shownFor, setShownFor] = useState(session.id)
  // Another session: its own draft.
  if (shownFor !== session.id) {
    setShownFor(session.id)
    setText(drafts.get(session.id) ?? '')
  }
  const change = (value: string) => {
    setText(value)
    drafts.set(session.id, value)
  }
  const send = async () => {
    const message = text.trim()
    if (!message || !client) return
    if (await client.sendPrompt(session.id, message)) change('')
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void send()
    }
  }
  return (
    <div className="flex items-end gap-2 border-t p-3">
      <Textarea
        rows={2}
        value={text}
        disabled={!session.canChat}
        onChange={event => change(event.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Message"
        placeholder={
          session.canChat
            ? (placeholder ?? 'Message Claude… (Enter sends, Shift+Enter: new line)')
            : 'Read only: this session takes no messages from here.'
        }
      />
      <Button size="icon" disabled={!session.canChat || !text.trim()} onClick={() => void send()} aria-label="Send">
        <SendIcon />
      </Button>
    </div>
  )
}
