import Foundation

/// Sessions whose sounds and alerts are muted for a while, from the session list's Snooze alerts menu. Permission requests
/// always come through: a muted session must never sit blocked without the user knowing. Kept in memory: a snooze lasts
/// minutes, and a restart of the app is a fair time for alerts to come back.
public struct AlertSnoozes: Equatable, Sendable {
    public enum Length: CaseIterable, Sendable {
        case quarterHour, hour, untilFinished

        public var label: String {
            switch self {
            case .quarterHour: "15 minutes"
            case .hour: "1 hour"
            case .untilFinished: "Until it finishes"
            }
        }
    }

    /// What would alert the user about a session.
    public enum Event: Equatable, Sendable {
        /// It needs the user: a question, an error, or a permission request.
        case needsYou(SessionStatus)
        /// It finished a task.
        case finished
        /// A usage limit that stopped it reset.
        case limitReset
    }

    enum Until: Equatable, Sendable {
        case date(Date)
        case finished
    }

    private var snoozed: [String: Until] = [:]

    public init() {}

    public mutating func snooze(_ sessionId: String, for length: Length, now: Date = Date()) {
        switch length {
        case .quarterHour: snoozed[sessionId] = .date(now.addingTimeInterval(15 * 60))
        case .hour: snoozed[sessionId] = .date(now.addingTimeInterval(3600))
        case .untilFinished: snoozed[sessionId] = .finished
        }
    }

    public mutating func wake(_ sessionId: String) {
        snoozed[sessionId] = nil
    }

    public func isSnoozed(_ sessionId: String, at now: Date = Date()) -> Bool {
        switch snoozed[sessionId] {
        case .date(let end): end > now
        case .finished: true
        case nil: false
        }
    }

    /// When a timed snooze ends, nil for none or until the session finishes.
    public func end(of sessionId: String) -> Date? {
        if case .date(let end) = snoozed[sessionId] { return end }
        return nil
    }

    /// Whether the event alerts the user. Finishing ends a snooze until it finishes, and that alert comes through: it is
    /// what the user waited for.
    public mutating func allows(_ event: Event, for sessionId: String, at now: Date = Date()) -> Bool {
        if case .needsYou(.permission) = event { return true }
        if event == .finished, snoozed[sessionId] == .finished {
            snoozed[sessionId] = nil
            return true
        }
        return !isSnoozed(sessionId, at: now)
    }

    /// Forgets the snoozes that ran out, and those of sessions that ended or left the list.
    public mutating func prune(keeping live: Set<String>, at now: Date = Date()) {
        snoozed = snoozed.filter { id, _ in live.contains(id) && isSnoozed(id, at: now) }
    }
}
