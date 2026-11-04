// The website's permission card: what the call will run, not only a description that can be a tool's whole docstring.
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Session } from '../../shared'
import { PermissionCard } from '../site/sessions/chat'

const session = { id: 's1' } as Session
const card = (description: string, inputPreview: string) =>
  renderToStaticMarkup(
    <PermissionCard
      session={session}
      request={{ requestId: 'r1', toolName: 'mcp__unreal__run', description, inputPreview, ts: '' }}
      machine={undefined}
      client={null}
    />,
  )

test('the card shows the arguments under a description cut to a few lines', () => {
  const docstring = Array.from({ length: 40 }, (_, i) => `Line ${i} of what the server says its tool does.`).join('\n')
  const html = card(docstring, '{"command":"rm -rf build"}')
  expect(html).toMatch(/<pre[^>]*>[^<]*rm -rf build[^<]*<\/pre>/)
  expect(html).toMatch(/<p class="[^"]*line-clamp-3[^"]*"[^>]*>Line 0 of/)
  expect(html).not.toMatch(/<pre[^>]*>Line 0 of/)
})

test('without a description or arguments, the card leaves them out', () => {
  const html = card('', '')
  expect(html).not.toContain('<p')
  expect(html).not.toContain('<pre')
})
