import Foundation

/// The coding agents whose sessions show in the notch.
public enum CodingTool: String, CaseIterable, Sendable {
    case claudeCode, openCode, codex

    /// From `SessionInfo.tool`: missing for Claude Code and from older agents. A tool this app does not know reads as
    /// Claude Code, as it did in apps from before the tool: the agent only lists the commands the session takes.
    public init(_ tool: String?) {
        switch tool {
        case "opencode": self = .openCode
        case "codex": self = .codex
        default: self = .claudeCode
        }
    }

    /// From a cluster or pool profile, which names every tool: nil for one this app does not know.
    public init?(command: String?) {
        guard let tool = Self.allCases.first(where: { $0.command == command }) else { return nil }
        self = tool
    }

    /// The tools the notch starts sessions of, and pool machines run. Codex sessions show, but are not started yet.
    public static let startable: [CodingTool] = [.claudeCode, .openCode]

    public var label: String {
        switch self {
        case .claudeCode: "Claude Code"
        case .openCode: "OpenCode"
        case .codex: "Codex"
        }
    }

    /// The command a machine starts it with, as the agent names it in its health report, and as cluster and pool profiles
    /// name the tool.
    public var command: String {
        switch self {
        case .claudeCode: "claude"
        case .openCode: "opencode"
        case .codex: "codex"
        }
    }

    /// As `SessionInfo.tool`, `StartOrder.tool` and `SharedInfo.tool` name it: nil for Claude Code.
    public var wire: String? { self == .claudeCode ? nil : command }

    /// An SF Symbol.
    public var symbol: String {
        switch self {
        case .claudeCode: "asterisk"
        case .openCode: "curlybraces"
        case .codex: "terminal"
        }
    }

    /// Beside a session's other details, in a title or an alert: nil for Claude Code, which most sessions run. Like
    /// `otherToolLabel` in shared/session.ts.
    public var otherLabel: String? { self == .claudeCode ? nil : label }
}

extension SessionSummary {
    public var codingTool: CodingTool { CodingTool(tool) }

    /// The session search: project, machine, title, or the tool, so "opencode" lists OpenCode's sessions.
    public func matches(_ query: String) -> Bool {
        query.isEmpty || project.localizedCaseInsensitiveContains(query) || (name?.localizedCaseInsensitiveContains(query) ?? false)
            || machine.localizedCaseInsensitiveContains(query)
            || (title?.localizedCaseInsensitiveContains(query) ?? false) || codingTool.label.localizedCaseInsensitiveContains(query)
    }
}

extension Array where Element == SessionSummary {
    /// Sessions of both tools are listed: each row then says which one runs it.
    public var mixesTools: Bool { Set(map(\.codingTool)).count > 1 }
}

extension MachineHealth {
    /// The coding tools its agent says are installed, those this app knows, in the app's order. Empty from older agents,
    /// which do not say.
    public var codingTools: [CodingTool] {
        guard let tools else { return [] }
        return CodingTool.allCases.filter { tools.contains($0.command) }
    }
}

extension MachineInfo {
    /// What the notch can start there: what its agent says is installed, or claude with agents that don't say.
    public var startableTools: [CodingTool] {
        guard let tools = health?.tools else { return [.claudeCode] }
        let listed = CodingTool.startable.filter { tools.contains($0.command) }
        return listed.isEmpty ? [.claudeCode] : listed
    }
}
