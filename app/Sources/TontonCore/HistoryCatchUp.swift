import Foundation

/// The relay sends the history of the session the app subscribes to, one at a time. A search needs every conversation, so
/// the app subscribes to each relay session it has no history for, one after the other, then back to the selected one.
/// It works with every relay: it sends nothing new, and coming back brings the selected session's whole history again.
public struct HistoryCatchUp: Equatable, Sendable {
    private var queue: [String] = []
    /// The session whose history is on its way.
    public private(set) var waitingFor: String?
    /// Done once per session while the app runs: a history kept up to date by live entries needs no second visit.
    private var visited: Set<String> = []

    public init() {}

    public var isRunning: Bool { waitingFor != nil }

    /// Starts with the sessions not visited yet, other than the selected one, which the app already follows. Returns the
    /// session to subscribe to first, or nil when there is nothing to fetch.
    public mutating func start(sessions: [String], selected: String?) -> String? {
        guard !isRunning else { return nil }
        queue = sessions.filter { $0 != selected && !visited.contains($0) }
        return next()
    }

    /// A history arrived. Returns the next session to subscribe to, or nil when the app should go back to the selected one.
    public mutating func received(_ sessionId: String) -> String? {
        guard sessionId == waitingFor else { return waitingFor }
        return next()
    }

    /// The connection dropped: what was not fetched waits for the next search.
    public mutating func cancel() {
        queue = []
        waitingFor = nil
    }

    private mutating func next() -> String? {
        guard !queue.isEmpty else {
            waitingFor = nil
            return nil
        }
        let id = queue.removeFirst()
        visited.insert(id)
        waitingFor = id
        return id
    }
}
