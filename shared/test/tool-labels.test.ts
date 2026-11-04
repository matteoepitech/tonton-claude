import { expect, test } from 'bun:test'
import { mcpTool, toolLabel } from '../session'
import table from './tool-labels.json'

test('how a tool reads, as the Swift side shows it', () => {
  for (const { name, label } of table.cases) expect([name, toolLabel(name)]).toEqual([name, label])
})

test('an MCP tool is its server and the rest of its name', () => {
  expect(mcpTool('mcp__srv__a__b')).toEqual({ server: 'srv', tool: 'a__b' })
  expect(['mcp__x', 'mcp____y', 'Bash', 'unreal-engine_spawn_actor'].map(mcpTool)).toEqual([null, null, null, null])
})
