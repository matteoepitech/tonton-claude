// Talks to the Tonton Claude app through its AppleScript dictionary (app/Resources/TontonClaude.sdef), in JavaScript for
// Automation. No Raycast import here, so `bun test` runs it from the repository root.

export type Status = 'starting' | 'working' | 'waiting' | 'permission' | 'idle' | 'error' | 'ended' | 'offline'

/** The coding tool that runs a session, as the app names it in a record (`CodingTool.command`). */
export type Tool = 'claude' | 'opencode' | 'codex'

export interface Session {
  session: string
  project: string
  machine: string
  status: Status
  title: string
  folder: string
  /** `claude` with apps from before the field, which only listed the tool in the notch. */
  tool: Tool
  /** Only when Settings › General › Show costs is on. */
  cost?: string
}

export const tools: Record<Tool, string> = { claude: 'Claude Code', opencode: 'OpenCode', codex: 'Codex' }

/** The list has sessions of several tools: each one then says which runs it, as in the notch. */
export const mixesTools = (sessions: Session[]): boolean => new Set(sessions.map(s => s.tool)).size > 1

/**
 * What Raycast's search looks in besides the project: the machine, the title and the tool by its name and its command,
 * so "codex" finds Codex's sessions and "code" Claude Code's.
 */
export const keywords = (session: Session): string[] =>
  [...new Set([session.machine, session.title, tools[session.tool], ...tools[session.tool].split(' '), session.tool])].filter(Boolean)

export const statuses: Record<Status, { label: string; color: string }> = {
  starting: { label: 'Starting', color: '#8A8F98' },
  working: { label: 'Working', color: '#7170FF' },
  waiting: { label: 'Waiting for you', color: '#F2C94C' },
  permission: { label: 'Needs approval', color: '#F2994A' },
  idle: { label: 'Done', color: '#4CB782' },
  error: { label: 'Error', color: '#EB5757' },
  ended: { label: 'Closed', color: '#5C6067' },
  offline: { label: 'Offline', color: '#5C6067' },
}

const app = "Application('Tonton Claude')"
const notRunning = 'Tonton Claude is not running.'

/** Each script checks that the app runs first: addressing it would launch it. */
export const scripts = {
  sessions: `function run() {
  if (!${app}.running()) throw new Error('${notRunning}')
  return JSON.stringify(${app}.sessionList())
}`,
  quickReplies: `function run() {
  if (!${app}.running()) throw new Error('${notRunning}')
  return JSON.stringify(${app}.quickReplies())
}`,
  // The text and the session arrive as arguments, never inside the script.
  send: `function run(argv) {
  if (!${app}.running()) throw new Error('${notRunning}')
  ${app}.sendMessage(argv[0], { to: argv[1] })
  return ''
}`,
}

/** The sessions the app returned, skipping anything that does not look like one: an older app may send other fields. */
export function parseSessions(output: string): Session[] {
  const list: unknown = JSON.parse(output || '[]')
  if (!Array.isArray(list)) return []
  return list.flatMap(item => {
    if (typeof item !== 'object' || item === null) return []
    const fields = item as Record<string, unknown>
    if (typeof fields.session !== 'string' || typeof fields.project !== 'string') return []
    const text = (key: string) => (typeof fields[key] === 'string' ? (fields[key] as string) : '')
    const status = text('status') in statuses ? (text('status') as Status) : 'offline'
    // A tool this extension does not know yet reads as Claude Code, as it does in the app.
    const tool = Object.hasOwn(tools, text('tool')) ? (text('tool') as Tool) : 'claude'
    const session: Session = {
      session: fields.session,
      project: fields.project,
      machine: text('machine'),
      status,
      title: text('title'),
      folder: text('folder'),
      tool,
    }
    if (text('cost')) session.cost = text('cost')
    return [session]
  })
}

export function parseReplies(output: string): string[] {
  const list: unknown = JSON.parse(output || '[]')
  return Array.isArray(list) ? list.filter((reply): reply is string => typeof reply === 'string' && reply.trim() !== '') : []
}

/**
 * The message the app or osascript gave, without osascript's wrapping:
 * `execution error: Error: Error: Scripts can't send messages. … (-10000)`.
 */
export function scriptError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const line = raw.split('\n').find(part => part.includes('execution error')) ?? raw
  const message = line
    .replace(/^.*?execution error:\s*/, '')
    .replace(/^(Error:\s*)+/, '')
    .replace(/\s*\(-?\d+\)\s*$/, '')
    .trim()
  if (/application can.t be found|Application isn.t running/i.test(message)) return 'Tonton Claude is not installed or not running.'
  return message || 'Tonton Claude did not answer.'
}

/** Live sessions first, then the most urgent, the way the notch orders them. */
export function sorted(sessions: Session[]): Session[] {
  const rank: Status[] = ['permission', 'error', 'waiting', 'working', 'starting', 'idle', 'ended', 'offline']
  return [...sessions].sort((a, b) => rank.indexOf(a.status) - rank.indexOf(b.status))
}
