// The "Claude Sessions" command: the sessions in the notch, a message or a quick reply to one of them.
import { Action, ActionPanel, Form, Icon, List, open, showToast, Toast, useNavigation } from '@raycast/api'
import { runAppleScript, usePromise } from '@raycast/utils'
import { parseReplies, parseSessions, type Session, scriptError, scripts, sorted, statuses } from './tonton'

const javascript = { language: 'JavaScript' as const }

async function load(): Promise<{ sessions: Session[]; replies: string[] }> {
  const [sessions, replies] = await Promise.all([
    runAppleScript(scripts.sessions, javascript),
    runAppleScript(scripts.quickReplies, javascript),
  ])
  return { sessions: sorted(parseSessions(sessions)), replies: parseReplies(replies) }
}

async function send(session: Session, text: string): Promise<boolean> {
  const toast = await showToast({ style: Toast.Style.Animated, title: `Sending to ${session.project}…` })
  try {
    await runAppleScript(scripts.send, [text, session.session], javascript)
    toast.style = Toast.Style.Success
    toast.title = `Sent to ${session.project}`
    return true
  } catch (error) {
    toast.style = Toast.Style.Failure
    toast.title = 'Not sent'
    toast.message = scriptError(error)
    return false
  }
}

export default function Command() {
  const { data, isLoading, error, revalidate } = usePromise(load)
  const sessions = data?.sessions ?? []

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search sessions">
      {error ? (
        <List.EmptyView
          icon={Icon.ExclamationMark}
          title={scriptError(error)}
          description="Open Tonton Claude, then try again."
          actions={
            <ActionPanel>
              <Action title="Try Again" icon={Icon.ArrowClockwise} onAction={revalidate} />
            </ActionPanel>
          }
        />
      ) : (
        <List.EmptyView icon={Icon.Terminal} title="No sessions" description="Sessions show up here once Claude Code runs." />
      )}
      {sessions.map(session => (
        <SessionItem key={session.session} session={session} replies={data?.replies ?? []} onSent={revalidate} />
      ))}
    </List>
  )
}

function SessionItem({ session, replies, onSent }: { session: Session; replies: string[]; onSent: () => void }) {
  const status = statuses[session.status]
  const accessories: List.Item.Accessory[] = [{ tag: { value: status.label, color: status.color } }]
  if (session.cost) accessories.unshift({ text: `$${session.cost}` })
  return (
    <List.Item
      icon={{ source: Icon.CircleFilled, tintColor: status.color }}
      title={session.project}
      subtitle={session.title}
      keywords={[session.machine, session.title]}
      accessories={[{ text: session.machine, icon: Icon.Monitor }, ...accessories]}
      actions={
        <ActionPanel>
          <Action.Push title="Send Message" icon={Icon.Message} target={<MessageForm session={session} onSent={onSent} />} />
          {replies.length > 0 && (
            <ActionPanel.Submenu title="Quick Reply" icon={Icon.Bubble} shortcut={{ modifiers: ['cmd'], key: 'r' }}>
              {replies.map(reply => (
                <Action key={reply} title={reply} onAction={async () => (await send(session, reply)) && onSent()} />
              ))}
            </ActionPanel.Submenu>
          )}
          <Action title="Open the Notch" icon={Icon.AppWindow} onAction={() => open('tonton://open')} />
          <Action.CopyToClipboard title="Copy Session Id" content={session.session} />
          {session.folder && <Action.ShowInFinder title="Show Folder in Finder" path={session.folder} />}
        </ActionPanel>
      }
    />
  )
}

function MessageForm({ session, onSent }: { session: Session; onSent: () => void }) {
  const { pop } = useNavigation()
  return (
    <Form
      navigationTitle={`Message ${session.project}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Send"
            icon={Icon.Message}
            onSubmit={async ({ text }: { text: string }) => {
              if (!text.trim()) return
              if (await send(session, text)) {
                onSent()
                pop()
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Description title="Session" text={`${session.project} · ${session.machine} · ${statuses[session.status].label}`} />
      <Form.TextArea id="text" title="Message" placeholder="What should Claude do?" autoFocus />
    </Form>
  )
}
