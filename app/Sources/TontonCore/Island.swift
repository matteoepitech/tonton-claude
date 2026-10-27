import Foundation

/// The iPhone's Live Activity, on the Lock Screen and in the Dynamic Island. Mirrors `IslandState` in shared/protocol.ts:
/// the phone sets it while it runs, and a relay with an APNs key pushes the same JSON while it does not. It only holds
/// what the relay can already see, ids, states and the agents' sealed blobs, which the widget opens with the account key.
public struct IslandState: Codable, Hashable, Sendable {
    public struct Session: Codable, Hashable, Sendable {
        public let id: String
        public let status: SessionStatus
        /// Sealed `SessionInfo`. Nil when unknown, or too long to push.
        public let info: String?
        /// Sealed `StatusDetail`, likewise.
        public let detail: String?

        public init(id: String, status: SessionStatus, info: String?, detail: String?) {
            (self.id, self.status, self.info, self.detail) = (id, status, info, detail)
        }
    }

    /// The sessions that need the user first, then the latest at work, then the latest done.
    public let sessions: [Session]
    /// Working or starting.
    public let working: Int
    /// Asking for a permission, waiting for the user or stopped by an error.
    public let attention: Int

    public init(sessions: [Session], working: Int, attention: Int) {
        (self.sessions, self.working, self.attention) = (sessions, working, attention)
    }

    /// At most this many sessions, like the relay: a push carries 4 KB.
    public static let maxSessions = 3
    /// Blobs longer than these are left out, like the relay does.
    public static let maxInfoLength = 1024
    public static let maxDetailLength = 512

    /// Built from the relay's sessions the same way the relay builds what it pushes (islandState in relay/src/push.ts).
    public init(_ wire: [WireSession]) {
        let ranked = wire.compactMap { session in Self.rank[session.status].map { (session, $0) } }
            .sorted { a, b in a.1 != b.1 ? a.1 < b.1 : a.0.lastActivity > b.0.lastActivity }
        sessions = ranked.prefix(Self.maxSessions).map { session, _ in
            Session(
                id: session.id, status: session.status, info: session.info.flatMap { $0.count <= Self.maxInfoLength ? $0 : nil },
                detail: session.statusDetail.flatMap { $0.count <= Self.maxDetailLength ? $0 : nil })
        }
        working = wire.filter { $0.status == .working || $0.status == .starting }.count
        attention = wire.filter(\.status.needsAttention).count
    }

    /// Ended and offline sessions are left out.
    private static let rank: [SessionStatus: Int] = [.permission: 0, .error: 1, .waiting: 2, .working: 3, .starting: 4, .idle: 5]

    /// Something runs or waits for the user: worth a place in the Dynamic Island.
    public var isActive: Bool { working + attention > 0 }

    /// The status the island shows for all of them.
    public var status: SessionStatus? { SessionStatus.mostUrgent(sessions.map(\.status)) }

    /// `1 needs you · 2 working`, `3 working`, `All done`.
    public var summary: String {
        let needs = attention == 0 ? nil : attention == 1 ? "1 needs you" : "\(attention) need you"
        let busy = working == 0 ? nil : "\(working) working"
        let parts = [needs, busy].compactMap { $0 }
        if !parts.isEmpty { return parts.joined(separator: " · ") }
        return sessions.isEmpty ? "Nothing running" : "All done"
    }

    /// What the compact Dynamic Island counts: those that need the user, or else those at work.
    public var count: Int { attention > 0 ? attention : working }
}

/// One session of the island, opened with the account key.
public struct IslandLine: Equatable, Sendable {
    public let id: String
    public let status: SessionStatus
    public let project: String
    public let machine: String?
    /// What it needs when it needs the user, otherwise its status.
    public let text: String

    /// Without the key: the states alone.
    public static func placeholders(_ state: IslandState) -> [IslandLine] {
        state.sessions.map {
            IslandLine(id: $0.id, status: $0.status, project: "Session", machine: nil, text: SessionSummary.statusText(nil, status: $0.status))
        }
    }
}

extension SessionVault {
    /// Placeholders when a blob is missing or does not open: the island still shows the states.
    public func lines(_ state: IslandState) -> [IslandLine] {
        state.sessions.map { session in
            let info = open(session.info, as: SessionInfo.self)
            let detail = open(session.detail, as: StatusDetail.self)?.text
            return IslandLine(
                id: session.id, status: session.status, project: info?.project ?? "Session", machine: info?.machine,
                text: SessionSummary.statusText(detail, status: session.status))
        }
    }
}
