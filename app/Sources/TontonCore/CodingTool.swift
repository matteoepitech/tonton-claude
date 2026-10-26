import Foundation

/// The coding agents whose sessions show in the notch.
public enum CodingTool: String, CaseIterable, Sendable {
    case claudeCode, openCode

    /// From `SessionInfo.tool`: missing for Claude Code and from older agents.
    public init(_ tool: String?) { self = tool == "opencode" ? .openCode : .claudeCode }

    public var label: String {
        switch self {
        case .claudeCode: "Claude Code"
        case .openCode: "OpenCode"
        }
    }

    /// The command a machine starts it with, as the agent names it in its health report.
    public var command: String {
        switch self {
        case .claudeCode: "claude"
        case .openCode: "opencode"
        }
    }

    /// An SF Symbol.
    public var symbol: String {
        switch self {
        case .claudeCode: "asterisk"
        case .openCode: "curlybraces"
        }
    }
}

extension SessionSummary {
    public var codingTool: CodingTool { CodingTool(tool) }

    /// The session search: project, machine, title, or the tool, so "opencode" lists OpenCode's sessions.
    public func matches(_ query: String) -> Bool {
        query.isEmpty || project.localizedCaseInsensitiveContains(query) || machine.localizedCaseInsensitiveContains(query)
            || (title?.localizedCaseInsensitiveContains(query) ?? false) || codingTool.label.localizedCaseInsensitiveContains(query)
    }
}

extension Array where Element == SessionSummary {
    /// Sessions of both tools are listed: each row then says which one runs it.
    public var mixesTools: Bool { Set(map(\.codingTool)).count > 1 }
}

extension MachineInfo {
    /// What the notch can start there: what its agent says is installed, or claude with agents that don't say.
    public var startableTools: [CodingTool] {
        guard let tools = health?.tools else { return [.claudeCode] }
        let listed = CodingTool.allCases.filter { tools.contains($0.command) }
        return listed.isEmpty ? [.claudeCode] : listed
    }
}
