import Foundation

/// What the notch asks a session's agent to run. A Claude Code channel can't, but a session running in tmux can be typed
/// into (Escape interrupts it), and OpenCode takes them through its API.
public enum SessionCommandName: String, Codable, CaseIterable, Sendable {
    case compact, clear, model, interrupt

    /// What agents that type in a terminal knew before `model`, and don't list.
    public static let original: Set<SessionCommandName> = [.compact, .clear]

    public var label: String {
        switch self {
        case .compact: "Compact the conversation"
        case .clear: "Clear the conversation…"
        case .model: "Model"
        case .interrupt: "Interrupt"
        }
    }

    /// Clearing starts over: the user confirms it first.
    public var needsConfirmation: Bool { self == .clear }
}

/// Bound to its session and run once, so the relay can neither move a `/clear` to another session nor replay it.
struct SessionCommand: Codable, Equatable {
    let name: SessionCommandName
    let sessionId: String
    let id: String
    let issuedAt: String
    /// For `model` only.
    var model: ModelFamily?
}

extension SessionSummary {
    /// Its agent runs the command now: slash commands while the session waits at its prompt, where Enter only submits
    /// them, and an interruption while it works.
    public func accepts(_ command: SessionCommandName) -> Bool {
        guard commands.contains(command), canChat, agentOnline else { return false }
        return command == .interrupt ? status == .working : status == .idle || status == .waiting
    }

    /// The slash commands of the menu in the chat header: the model has its own menu, interrupting its own button.
    public var menuCommands: [SessionCommandName] { [.compact, .clear].filter(commands.contains) }

    public var acceptsCommands: Bool { menuCommands.contains { accepts($0) } }

    /// The model it uses now, as Claude Code's menu names it.
    public var modelName: String? { model.map(ModelName.display) }
    public var modelFamily: ModelFamily? { model.flatMap(ModelName.family) }
}
