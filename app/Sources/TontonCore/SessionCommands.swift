import Foundation

/// What the notch asks a session's agent to run. A Claude Code channel can't, but a session running in tmux can be typed
/// into (Escape interrupts it), and OpenCode takes them through its API.
public enum SessionCommandName: String, Codable, CaseIterable, Sendable {
    case compact, clear, interrupt

    public var label: String {
        switch self {
        case .compact: "Compact the conversation"
        case .clear: "Clear the conversation…"
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
}

extension SessionSummary {
    /// Its agent runs the command now: slash commands while the session waits at its prompt, where Enter only submits
    /// them, and an interruption while it works.
    public func accepts(_ command: SessionCommandName) -> Bool {
        guard commands.contains(command), canChat, agentOnline else { return false }
        return command == .interrupt ? status == .working : status == .idle || status == .waiting
    }

    /// The slash commands of the menu in the chat header.
    public var menuCommands: [SessionCommandName] { commands.filter { $0 != .interrupt } }

    public var acceptsCommands: Bool { menuCommands.contains { accepts($0) } }
}
