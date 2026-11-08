// Codex's tools under the names the clients know from Claude Code (Bash, Edit, TodoWrite…), so the notch, the changed
// files, the cluster detector and the auto-approve rules read a Codex session as they read a Claude Code one. Like
// `claudeToolName` for OpenCode (agent/src/opencode/events.ts). shared/test/codex-tool-names.json holds the cases.

/** Codex's tools that run a command, in rollouts from 2025 on: `shell` and `container.exec` take an argv. */
export const CODEX_SHELL_TOOLS = new Set(['shell', 'container.exec', 'shell_command', 'exec_command', 'local_shell'])

/** The Claude Code name of each built-in tool of Codex that has one. */
const CLAUDE_NAMES: Record<string, string> = {
  shell: 'Bash',
  'container.exec': 'Bash',
  shell_command: 'Bash',
  exec_command: 'Bash',
  local_shell: 'Bash',
  update_plan: 'TodoWrite',
  view_image: 'Read',
  web_search: 'WebSearch',
  spawn_agent: 'Task',
  request_user_input: 'AskUserQuestion',
  tool_search: 'ToolSearch',
  list_mcp_resources: 'ListMcpResourcesTool',
  read_mcp_resource: 'ReadMcpResourceTool',
}

/**
 * A tool of Codex under Claude Code's name. An MCP tool comes as its namespace and its name, which Codex joins as
 * `mcp__<server>__<tool>`, the way Claude Code names them, trimming the `_` the namespace ends with and the name starts
 * with (codex-rs/core/src/tools/handlers/mcp.rs). `apply_patch` has no single name: each file it touches becomes an
 * Edit or a Write (./patch.ts). Any other name stays as it is.
 */
export function codexToolName(name: string, namespace?: string): string {
  if (namespace) {
    const joined = `${namespace.replace(/_+$/, '')}__${name.replace(/^_+/, '')}`
    return joined.startsWith('mcp__') ? joined : `mcp__${joined}`
  }
  return Object.hasOwn(CLAUDE_NAMES, name) ? CLAUDE_NAMES[name] : name
}

/**
 * The command of a shell call, as one line a person would type: `["bash", "-lc", "cargo test"]` is `cargo test`. Codex's
 * tools give it as `cmd` (exec_command), `command` as a string (shell_command) or as an argv (shell, local_shell).
 */
export function shellCommand(input: Record<string, unknown>): string | undefined {
  const value = input.cmd ?? input.command
  if (typeof value === 'string') return value.trim() ? value : undefined
  if (!Array.isArray(value) || !value.every(part => typeof part === 'string')) return undefined
  const argv = value as string[]
  const script = argv.length === 3 && /(^|[\\/])(ba|z|da|k)?sh$/.test(argv[0]) && /^-l?c$/.test(argv[1]) ? argv[2] : undefined
  if (script !== undefined) return script
  const pwsh = argv.findIndex(part => /^-(Command|c)$/i.test(part))
  if (pwsh > 0 && /powershell|pwsh/i.test(argv[0]) && pwsh === argv.length - 2) return argv[pwsh + 1]
  return argv.map(part => (/^[\w./:=@%+-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`)).join(' ') || undefined
}
