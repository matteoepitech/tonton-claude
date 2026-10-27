// The views of a client: the session list, a conversation with its permission cards and composer, and a read-only share.
// The web app and the Windows and Linux island (desktop/) render them; each brings its own client and layout.

import {
  accepts,
  type ClientState,
  changedFiles,
  chatItems,
  displayStatusText,
  type Entry,
  isLive,
  keepsSessionRules,
  type Machine,
  menuCommands,
  modelName,
  needsAttention,
  type RelayClient,
  type Session,
  type SharedView,
  STATUS_LABELS,
  sessionRuleFor,
  shownPath,
} from '../shared'
import type { SessionCommand, SessionStatus } from '../shared/protocol'
import { element, inline, renderMarkdown } from './markdown'

// MARK: Sessions

/** The sessions, grouped by machine. */
export function renderList(list: HTMLElement, current: ClientState, onPick: (session: Session) => void) {
  const groups = new Map<string, Session[]>()
  for (const session of current.sessions) groups.set(session.machine, [...(groups.get(session.machine) ?? []), session])
  const children: HTMLElement[] = []
  if (!current.sessions.length) children.push(element('p', current.connection === 'connected' ? 'No sessions yet.' : 'Connecting…'))
  for (const [machine, sessions] of groups) {
    children.push(element('h2', machine))
    for (const session of sessions) {
      const row = element(
        'button',
        dot(session.status),
        element(
          'span',
          element('strong', session.name ?? session.project),
          element('small', needsAttention(session.status) ? displayStatusText(session) : (session.title ?? STATUS_LABELS[session.status])),
        ),
      )
      row.className = 'session'
      if (session.id === current.selectedId) row.classList.add('selected')
      if (!isLive(session.status)) row.classList.add('finished')
      row.onclick = () => onPick(session)
      children.push(row)
    }
  }
  list.replaceChildren(...children)
}

export function dot(status: SessionStatus): HTMLElement {
  const node = element('i')
  node.className = `dot ${status}`
  node.title = STATUS_LABELS[status]
  return node
}

// MARK: Conversation

/** Kept across renders: what is being typed, and whether the conversation follows its end. */
let draft = ''
let stickToBottom = true

/** The selected session's conversation. `onBack` returns to the list where the two do not fit side by side. */
export function renderChat(chat: HTMLElement, current: ClientState, client: RelayClient | null, onBack: () => void) {
  const session = current.sessions.find(s => s.id === current.selectedId)
  if (!session) {
    chat.replaceChildren(element('p', 'Pick a session.'))
    return
  }
  const previous = chat.querySelector('.messages')
  if (previous) stickToBottom = previous.scrollHeight - previous.scrollTop - previous.clientHeight < 40
  const back = element('button', '‹ Sessions')
  back.className = 'back'
  back.onclick = onBack
  const details = [
    session.machine,
    session.branch ? `⎇ ${session.branch}` : null,
    session.model ? modelName(session.model) : null,
    session.tool === 'opencode' ? 'OpenCode' : null,
  ]
  const header = element(
    'div',
    back,
    dot(session.status),
    element('span', element('strong', session.name ?? session.project), element('small', details.filter(Boolean).join(' · '))),
    element('em', needsAttention(session.status) ? displayStatusText(session) : STATUS_LABELS[session.status]),
    ...commandButtons(session, client),
    ...filesButton(session, current.entries ?? [], () => renderChat(chat, current, client, onBack)),
  )
  header.className = 'chat-header'
  if (filesOf === session.id) {
    chat.replaceChildren(header, changedFilesList(session, current.entries ?? []), composer(session, client))
    return
  }
  const messages = element('div')
  messages.className = 'messages'
  if (!current.entries) messages.append(loading('Loading the conversation…'))
  // The end of a long conversation shows first, the rest of it right after.
  else if (current.loadingEarlier) messages.append(loading('Loading earlier messages…'))
  for (const item of chatItems(current.entries ?? [])) messages.append(message(item))
  const machine = current.machines.find(m => m.id === session.machineId)
  for (const request of session.pendingPermissions) messages.append(permission(session, request, machine, client))
  // The conversation is rebuilt on every change of the session: someone typing keeps the keyboard and the caret.
  const typing =
    document.activeElement instanceof HTMLTextAreaElement && chat.contains(document.activeElement) ? document.activeElement : null
  const field = composer(session, client)
  chat.replaceChildren(header, messages, field)
  if (stickToBottom) messages.scrollTop = messages.scrollHeight
  const input = field.querySelector('textarea')
  if (typing && input && !input.disabled) {
    input.focus()
    input.setSelectionRange(typing.selectionStart, typing.selectionEnd)
  }
}

/** The session whose changed files show instead of its conversation. */
let filesOf: string | null = null

function filesButton(session: Session, entries: readonly Entry[], rerender: () => void): HTMLElement[] {
  const count = changedFiles(entries).length
  if (!count) return []
  const button = element('button', filesOf === session.id ? 'Conversation' : `Files (${count})`)
  button.title = 'Files changed in this session'
  button.onclick = () => {
    filesOf = filesOf === session.id ? null : session.id
    rerender()
  }
  return [button]
}

/** Each file Claude changed, the most recent first, with its diffs. */
function changedFilesList(session: Session, entries: readonly Entry[]): HTMLElement {
  const list = element('div')
  list.className = 'messages'
  for (const file of changedFiles(entries)) {
    const changes = file.changes
      ? `${file.changes} change${file.changes === 1 ? '' : 's'}${file.written && !file.edits.length ? ', written' : ''}`
      : 'failed'
    const summary = element(
      'summary',
      element('strong', file.name),
      ` ${shownPath(file.path, session.cwd)} · ${changes}${file.lastFailed ? ' · the last change failed' : ''}`,
    )
    const item = element('details', summary)
    item.className = file.lastFailed ? 'tool failed' : 'tool'
    for (const edit of file.edits) {
      const diff = element('pre')
      diff.className = 'diff'
      diff.append(element('del', edit.oldText), element('ins', edit.newText))
      item.append(diff)
    }
    list.append(item)
  }
  return list
}

function message(item: ReturnType<typeof chatItems>[number]): HTMLElement {
  if (item.kind === 'user') {
    const bubble = element('div', ...inline(item.entry.text))
    bubble.className = 'user'
    return bubble
  }
  if (item.kind === 'assistant') {
    const text = element('div', renderMarkdown(item.entry.text))
    text.className = 'assistant'
    return text
  }
  if (item.kind === 'system') {
    const note = element('p', item.entry.text)
    note.className = 'system'
    return note
  }
  const summary = element('summary', element('strong', item.call.name), ` ${item.call.summary}`)
  const tool = element('details', summary)
  tool.className = item.result?.isError ? 'tool failed' : item.result ? 'tool' : 'tool running'
  if (item.result?.text) tool.append(element('pre', item.result.text))
  for (const edit of item.call.edits ?? []) {
    const diff = element('pre')
    diff.className = 'diff'
    diff.append(element('del', edit.oldText), element('ins', edit.newText))
    tool.append(diff)
  }
  return tool
}

function permission(
  session: Session,
  request: Session['pendingPermissions'][number],
  machine: Machine | undefined,
  client: RelayClient | null,
): HTMLElement {
  const allow = element('button', 'Allow')
  allow.className = 'primary'
  const deny = element('button', 'Deny')
  allow.onclick = () => client?.answer(session.id, request.requestId, true)
  deny.onclick = () => client?.answer(session.id, request.requestId, false)
  const buttons = element('div', deny)
  const rule = keepsSessionRules(machine) ? sessionRuleFor(request.toolName, request.inputPreview) : null
  if (rule) {
    const label = rule.label.length > 40 ? `${rule.label.slice(0, 40)}…` : rule.label
    const always = element('button', `Allow for this session: ${label}`)
    always.title = `${rule.label}: calls like this one are allowed until the session ends.`
    always.onclick = () => void client?.allowForSession(session.id, request.requestId, rule.rules)
    buttons.append(always)
  }
  buttons.append(allow)
  const card = element('div', element('strong', `${request.toolName} wants to run`), element('pre', request.description), buttons)
  card.className = 'permission'
  return card
}

function composer(session: Session, client: RelayClient | null): HTMLElement {
  const field = element('textarea')
  field.rows = 2
  field.value = draft
  field.disabled = !session.canChat
  field.placeholder = session.canChat
    ? 'Message Claude… (Enter sends, Shift+Enter: new line)'
    : 'Read only: this session takes no messages from here.'
  field.oninput = () => {
    draft = field.value
  }
  const send = element('button', 'Send')
  send.className = 'primary'
  send.disabled = !session.canChat
  const submit = async () => {
    const text = field.value.trim()
    if (!text || !client) return
    if (await client.sendPrompt(session.id, text)) {
      draft = ''
      field.value = ''
    }
  }
  send.onclick = () => void submit()
  field.onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void submit()
    }
  }
  const form = element('div', field, send)
  form.className = 'composer'
  return form
}

/** Interrupt while it works; compact and clear while it waits. Only what its agent says it runs. */
function commandButtons(session: Session, client: RelayClient | null): HTMLElement[] {
  const names: SessionCommand['name'][] = [...(accepts(session, 'interrupt') ? (['interrupt'] as const) : []), ...menuCommands(session)]
  const labels: Record<string, string> = { interrupt: 'Stop', compact: 'Compact', clear: 'Clear' }
  return names.map(name => {
    const button = element('button', labels[name] ?? name)
    button.disabled = !accepts(session, name)
    button.onclick = () => {
      if (name === 'clear' && !confirm('Clear the conversation? Claude starts over.')) return
      void client?.sendCommand(session.id, name)
    }
    return button
  })
}

// MARK: Read-only share

/** One session a teammate shared: its conversation, live, and nothing that could act on it. */
export function renderShared(view: SharedView, status: HTMLElement, chat: HTMLElement) {
  status.textContent = view.connection === 'connected' ? '● connected' : view.connection === 'ended' ? '○ ended' : '○ connecting'
  status.dataset.state = view.connection === 'connected' ? 'connected' : 'offline'
  const previous = chat.querySelector('.messages')
  if (previous) stickToBottom = previous.scrollHeight - previous.scrollTop - previous.clientHeight < 40
  const details = [view.title, view.tool === 'opencode' ? 'OpenCode' : null].filter(Boolean).join(' · ')
  const header = element(
    'div',
    ...(view.status ? [dot(view.status)] : []),
    element('span', element('strong', view.project ?? 'Shared session'), element('small', details)),
    element('em', view.status ? STATUS_LABELS[view.status] : ''),
  )
  header.className = 'chat-header'
  const messages = element('div')
  messages.className = 'messages'
  if (!view.entries) messages.append(loading('Loading the conversation…'))
  for (const item of chatItems(view.entries ?? [])) messages.append(message(item))
  const children: HTMLElement[] = [header, messages]
  if (view.connection === 'ended') {
    const ended = element('p', 'This share ended: it was revoked or it expired.')
    ended.className = 'ended'
    children.push(ended)
  }
  chat.replaceChildren(...children)
  if (stickToBottom) messages.scrollTop = messages.scrollHeight
}

/** Says the conversation is on its way, with a spinner. */
function loading(text: string): HTMLElement {
  const note = element('p', element('i'), text)
  note.className = 'loading'
  return note
}
