import Foundation

/// Slash commands the notch types in a session's terminal. A channel can't run them, but a session running in tmux can be
/// typed into, and its agent does it.
public enum SessionCommandName: String, Codable, CaseIterable, Sendable {
    case compact, clear

    public var label: String {
        switch self {
        case .compact: "Compact the conversation"
        case .clear: "Clear the conversation…"
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
    /// Its agent can type in its terminal, and Claude waits at its prompt: Enter then only submits the command.
    public var acceptsCommands: Bool {
        terminal && canChat && agentOnline && (status == .idle || status == .waiting)
    }
}
