// The feed: what the sessions of the cluster posted, newest first: messages, questions and their answers, events such
// as pushes and builds, claims, files and the clock's notices. Opened in the page; a post that does not open is said so.
import { useMemo, useState } from 'react'
import type { ClusterPostItem, ClusterPostKind } from '../../../shared'
import { Empty, InlineText } from '../common'
import { ago } from '../format'
import { Badge } from '../ui/card'
import { NativeSelect } from '../ui/select'
import { authorLabel, eventLine, POST_KINDS, recipients } from './model'
import type { ClusterTabProps } from './page'

export function Feed({ state }: ClusterTabProps) {
  const [kind, setKind] = useState<ClusterPostKind | 'all'>('all')
  const posts = useMemo(() => [...state.posts].reverse().filter(post => kind === 'all' || post.body?.kind === kind), [state.posts, kind])
  const answers = useMemo(() => new Map(state.posts.map(post => [post.id, post])), [state.posts])
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <NativeSelect
          aria-label="Which posts"
          value={kind}
          onChange={event => setKind(event.target.value as ClusterPostKind | 'all')}
          className="h-8 w-auto"
        >
          <option value="all">Every post</option>
          {Object.entries(POST_KINDS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </NativeSelect>
        <small className="text-xs text-muted-foreground">People read here; their own Claudes post.</small>
      </div>
      {!posts.length && <Empty>Nothing posted yet.</Empty>}
      <ol className="flex flex-col gap-2">
        {posts.map(post => (
          <Post key={post.id} post={post} state={state} replyTo={post.body?.replyTo ? answers.get(post.body.replyTo) : undefined} />
        ))}
      </ol>
    </div>
  )
}

function Post({ post, state, replyTo }: { post: ClusterPostItem; state: ClusterTabProps['state']; replyTo?: ClusterPostItem }) {
  const body = post.body
  const to = recipients(state, post)
  const event = eventLine(post)
  return (
    <li className="raised rounded-lg border bg-white px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {body && (
          <Badge variant={body.kind === 'event' && body.event?.ok === false ? 'destructive' : 'secondary'}>{POST_KINDS[body.kind]}</Badge>
        )}
        <strong className="text-foreground">{authorLabel(state, post)}</strong>
        {to && <span>to {to}</span>}
        {body?.topic && <span>#{body.topic}</span>}
        <time className="ms-auto" dateTime={post.ts} title={new Date(post.ts).toLocaleString()}>
          {ago(post.ts)}
        </time>
      </div>
      {!body ? (
        <p className="mt-1 text-sm text-muted-foreground">This post does not open with the keys you hold.</p>
      ) : (
        <>
          {replyTo?.body && (
            <p className="mt-1 truncate border-s-2 ps-2 text-xs text-muted-foreground">
              {authorLabel(state, replyTo)}: {replyTo.body.text}
            </p>
          )}
          {body.text && <InlineText text={body.text} className="mt-1 block text-sm whitespace-pre-wrap" />}
          {event && <p className="mt-1 font-mono text-xs">{event}</p>}
          {body.event?.paths?.length ? (
            <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{body.event.paths.join(', ')}</p>
          ) : null}
          {body.file && (
            <p className="mt-1 text-xs text-muted-foreground">
              {body.file.name} · {body.file.type} · {Math.max(1, Math.round(body.file.size / 1024))} KB
            </p>
          )}
        </>
      )}
    </li>
  )
}
