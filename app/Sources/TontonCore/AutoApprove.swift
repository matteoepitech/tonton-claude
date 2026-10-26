import Foundation

/// A tool call an agent approves without asking, as the agent reads it (sealed in a `RuleSet`).
public struct PermissionRule: Codable, Equatable, Sendable {
    public let tool: String
    /// `npm test` matches that command only, `npm run *` anything after `npm run `. Nil: any call of the tool.
    public let pattern: String?

    public init(tool: String, pattern: String?) {
        self.tool = tool
        self.pattern = pattern
    }
}

/// What the app seals for a machine: its rules and when they were set, so a relay can't bring back older ones.
struct RuleSet: Codable {
    let rules: [PermissionRule]
    let issuedAt: String
}

/// An auto-approve rule as Settings › Machines keeps it: for every machine, or for one.
public struct AutoApproveRule: Codable, Equatable, Identifiable, Sendable {
    public var id = UUID()
    public var tool: String
    public var pattern: String
    /// Nil for every machine.
    public var machineId: String?

    public init(tool: String, pattern: String, machineId: String?) {
        self.tool = tool
        self.pattern = pattern
        self.machineId = machineId
    }

    /// The tools a rule can name, with the field their pattern matches.
    public static let tools = ["Bash", "PowerShell", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"]

    /// The rules a machine gets: the ones for every machine and its own.
    public static func rules(_ all: [AutoApproveRule], for machineId: String) -> [PermissionRule] {
        all.filter { $0.machineId == nil || $0.machineId == machineId }.map { rule in
            let pattern = rule.pattern.trimmingCharacters(in: .whitespacesAndNewlines)
            return PermissionRule(tool: rule.tool, pattern: pattern.isEmpty ? nil : pattern)
        }
    }
}
