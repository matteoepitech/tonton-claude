import Foundation

/// What the collapsed notch shows when it widens like the Dynamic Island: one session and one line about it.
public enum LiveActivity {
    /// The session that needs the user most, or else the most recently active one at work. Nil when nothing is going on.
    public static func pick(_ sessions: [SessionSummary]) -> SessionSummary? {
        let rank: [SessionStatus: Int] = [.permission: 0, .error: 1, .waiting: 2, .working: 3]
        return sessions.filter { rank[$0.status] != nil }.min { a, b in
            let ra = rank[a.status] ?? 9, rb = rank[b.status] ?? 9
            return ra != rb ? ra < rb : a.lastActivity > b.lastActivity
        }
    }

    /// What it needs when it needs the user, otherwise what it is working on.
    public static func text(_ session: SessionSummary) -> String {
        session.status.needsAttention ? session.displayStatusText : session.title ?? session.lastMessage ?? session.status.label
    }
}
