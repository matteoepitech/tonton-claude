import Foundation

/// A tool as a person reads it: `unreal-engine · spawn_actor` for the MCP tool `mcp__unreal-engine__spawn_actor`, any
/// other name as it is. Only for showing: rules, icons, changed files and counts go by the name itself. Like `toolLabel`
/// in shared/session.ts; both check shared/test/tool-labels.json.
public enum ToolLabel {
    /// The server and the tool of an MCP tool, split as Claude Code does: `mcp__<server>__<tool>`, where the tool may hold
    /// `__` itself. The agent names OpenCode's MCP tools the same way. Nil for any other name.
    public static func mcp(_ name: String) -> (server: String, tool: String)? {
        let parts = name.components(separatedBy: "__")
        guard parts.count >= 3, parts[0] == "mcp", !parts[1].isEmpty else { return nil }
        let tool = parts.dropFirst(2).joined(separator: "__")
        return tool.isEmpty ? nil : (parts[1], tool)
    }

    public static func text(_ name: String) -> String {
        guard let mcp = mcp(name) else { return name }
        return "\(mcp.server) · \(mcp.tool)"
    }

    /// What VoiceOver reads: "unreal-engine, spawn actor", not each underscore.
    public static func spoken(_ name: String) -> String {
        guard let mcp = mcp(name) else { return name }
        return "\(mcp.server), \(mcp.tool.replacing(#/_+/#, with: " ").trimmingCharacters(in: .whitespaces))"
    }
}
