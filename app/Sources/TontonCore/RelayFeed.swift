import Foundation

/// The account as the iPhone app holds it: the relay's messages applied in order and opened with the account key.
public struct RelayFeed: Sendable {
    /// Live sessions first, then the most recent.
    public private(set) var sessions: [SessionSummary] = []
    public private(set) var machines: [MachineInfo] = []
    /// The conversation of each session the app subscribed to.
    public private(set) var entries: [String: [Entry]] = [:]
    public private(set) var lastError: String?
    /// Snapshots received so far: one comes with each new connection, so a count that grew means the feed is current.
    public private(set) var snapshots = 0
    /// Sessions of which only the latest entries came yet: the rest of their history is on its way.
    public private(set) var partial: Set<String> = []
    /// The sessions as the relay sent them, still sealed: the Live Activity carries them that way.
    private var wire: [String: WireSession] = [:]

    public init() {}

    public var island: IslandState { IslandState(Array(wire.values)) }

    public func session(_ id: String) -> SessionSummary? { sessions.first { $0.id == id } }

    public mutating func apply(_ message: RelayMessage, vault: SessionVault) {
        switch message {
        case .snapshot(let wireSessions, let wireMachines):
            snapshots += 1
            machines = vault.machines(wireMachines)
            wire = Dictionary(wireSessions.map { ($0.id, $0) }) { _, last in last }
            sessions = Self.sorted(wireSessions.map { vault.session($0, machines: machines) })
            entries = entries.filter { wire[$0.key] != nil }
        case .session(let session):
            wire[session.id] = session
            sessions = Self.sorted(sessions.filter { $0.id != session.id } + [vault.session(session, machines: machines)])
        case .removed(let sessionId):
            wire[sessionId] = nil
            sessions.removeAll { $0.id == sessionId }
            entries[sessionId] = nil
        case .machines(let wireMachines):
            machines = vault.machines(wireMachines)
        case .history(let sessionId, let wireEntries):
            entries[sessionId] = vault.entries(wireEntries)
            partial.remove(sessionId)
        case .recentHistory(let sessionId, let wireEntries):
            guard ConversationLoad.takesRecent(current: entries[sessionId], partial: partial.contains(sessionId)) else { return }
            entries[sessionId] = vault.entries(wireEntries)
            partial.insert(sessionId)
        case .entries(let sessionId, let wireEntries):
            let known = Set(entries[sessionId, default: []].map(\.id))
            entries[sessionId, default: []] += vault.entries(wireEntries).filter { !known.contains($0.id) }
        case .error(let text):
            lastError = text
        default:
            // The Mac's business, like updating agents, starting sessions or reading their logs.
            break
        }
    }

    public mutating func clearError() { lastError = nil }

    private static func sorted(_ list: [SessionSummary]) -> [SessionSummary] {
        list.sorted { a, b in a.status.isLive != b.status.isLive ? a.status.isLive : a.lastActivity > b.lastActivity }
    }
}

/// The phone's list: what needs the user, what runs, what is done, what is gone.
public struct SessionGroup: Identifiable, Equatable, Sendable {
    public enum Kind: String, CaseIterable, Sendable {
        case needsYou, working, done, closed

        public var title: String {
            switch self {
            case .needsYou: "Needs you"
            case .working: "Working"
            case .done: "Done"
            case .closed: "Closed"
            }
        }

        static func of(_ status: SessionStatus) -> Kind {
            switch status {
            case .permission, .waiting, .error: .needsYou
            case .working, .starting: .working
            case .idle: .done
            case .ended, .offline: .closed
            }
        }
    }

    public let kind: Kind
    public let sessions: [SessionSummary]
    public var id: Kind { kind }

    /// Empty groups are left out; each keeps the order it is given.
    public static func groups(_ sessions: [SessionSummary]) -> [SessionGroup] {
        Kind.allCases.compactMap { kind in
            let members = sessions.filter { Kind.of($0.status) == kind }
            return members.isEmpty ? nil : SessionGroup(kind: kind, sessions: members)
        }
    }
}
