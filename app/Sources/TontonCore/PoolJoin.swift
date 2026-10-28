import Foundation

/// The kind of task a pool session takes (docs/pools.md, Sizes of work). OpenCode sessions are less capable than Claude
/// Code's: by default they take the simpler, well-bounded tasks, and Claude Code sessions the features that need broad
/// context. The machine owner can change it when the session joins. Mirrors `poolTaskSize` in shared/pool.ts.
public enum PoolTaskSize: String, CaseIterable, Sendable, Identifiable {
    case simple, large

    public var id: String { rawValue }

    public static func `default`(for tool: CodingTool) -> PoolTaskSize { tool == .openCode ? .simple : .large }

    /// The owner's choice in the profile, or by the tool.
    public static func of(_ profile: PoolSessionProfile?, tool: CodingTool) -> PoolTaskSize {
        profile?.takes.flatMap(PoolTaskSize.init(rawValue:)) ?? .default(for: tool)
    }

    public var label: String {
        switch self {
        case .simple: String(core: "Simple tasks: tests, docs, small fixes")
        case .large: String(core: "Large tasks: features that need context")
        }
    }
}

/// What the owner of a session fills in to put it in a pool.
public struct PoolJoinForm: Equatable, Sendable {
    /// The areas the pool's orchestrator assigns by. Anything else can be typed.
    public static let areas = ["front", "back", "infra", "tests", "docs", "review"]

    public var area: String
    public var skills: String
    public var repo: String
    public var takes: PoolTaskSize
    /// Start pool tasks as soon as they are assigned, or ask in the notch first.
    public var autoStart: Bool

    /// For a session: its folder as the repo, its tool's kind of task, and starting what the pool gives it, as a pool
    /// machine's sessions do: its owner unticks it to be asked first. Permission prompts still come to the owner.
    public init(session: SessionSummary) {
        area = ""
        skills = ""
        repo = session.cwd
        takes = .default(for: session.codingTool)
        autoStart = true
    }

    /// What the pool sees of the session: what the owner typed, its project, machine and tool.
    public func profile(for session: SessionSummary) -> PoolSessionProfile {
        func nonEmpty(_ text: String) -> String? {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : String(trimmed.prefix(500))
        }
        return PoolSessionProfile(
            area: nonEmpty(area).map { $0.lowercased() }, skills: nonEmpty(skills), repo: nonEmpty(repo), project: session.project,
            machine: session.machine, tool: session.codingTool == .openCode ? "opencode" : "claude", takes: takes.rawValue)
    }
}

extension MachineInfo {
    /// Agents from this version take a session into a pool; older ones ignore the order.
    public static let poolsSince = "0.8.0"

    public var joinsPools: Bool { runs(atLeast: Self.poolsSince) }
}

public enum PoolLinks {
    /// The pool on the relay's website. The pool id goes after `#`, so it is never sent to the relay with the page.
    public static func website(relay: String, pool: String) -> URL? {
        URL(string: "\(RelayAPI.normalize(relay))/#pool=\(pool)")
    }

    /// What the owner sends a session to start a task it asked about first: Claude then claims it with its pool tools.
    public static func acceptPrompt(taskId: String, title: String) -> String {
        String(core: "I agree: start the pool task “\(title)” (\(taskId)). Claim it with task_claim, then work on it.")
    }

    /// And when the owner refuses it: the task goes back to the board, and Claude leaves it.
    public static func refusePrompt(taskId: String, title: String) -> String {
        String(core: "I refused the pool task “\(title)” (\(taskId)): do not start it. It is back on the pool's board.")
    }
}
