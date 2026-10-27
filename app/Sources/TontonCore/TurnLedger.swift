import Foundation

/// A turn of Claude that ended: when, and how long it took, from the prompt to the answer.
public struct Turn: Codable, Equatable, Sendable {
    public let end: Date
    public let seconds: TimeInterval

    public init(end: Date, seconds: TimeInterval) {
        self.end = end
        self.seconds = seconds
    }
}

/// What the app counted of each session's work, so that a turn counts once: whether the app saw it end, or the agent
/// reported it later because it ended while the Mac was away. Wrapped and the busy hours then include both.
public struct TurnLedger: Codable, Equatable, Sendable {
    struct Mark: Codable, Equatable, Sendable {
        let end: Date
        /// Seen ending by the app, rather than reported by the agent.
        let live: Bool
        /// Matched with the same turn from the other side.
        var paired: Bool
    }

    /// When this version first ran. Older versions counted earlier turns live, or not at all.
    public private(set) var since: Date
    private(set) var marks: [String: [Mark]] = [:]

    /// The app sees a turn end when its status turns idle, a few seconds after Claude Code writes it down.
    static let sameTurn: TimeInterval = 120
    /// Turns older than this are not counted any more, so their marks can go.
    static let kept: TimeInterval = 14 * 86400

    public init(since: Date = Date()) {
        self.since = since
    }

    /// A task the app saw end. False when the agent already reported it: it was counted then.
    public mutating func live(session: String, end: Date) -> Bool {
        prune(now: end)
        var list = marks[session] ?? []
        defer { marks[session] = list }
        if let index = nearest(in: list, to: end, live: false) {
            list[index].paired = true
            list.append(Mark(end: end, live: true, paired: true))
            return false
        }
        list.append(Mark(end: end, live: true, paired: false))
        return true
    }

    /// The reported turns to count: ended since this version runs, in the last two weeks, and neither reported before
    /// nor seen ending by the app.
    public mutating func reported(session: String, turns: [Turn], now: Date = Date()) -> [Turn] {
        prune(now: now)
        var list = marks[session] ?? []
        var fresh: [Turn] = []
        for turn in turns where turn.seconds > 0 && turn.end >= since && now.timeIntervalSince(turn.end) < Self.kept {
            // Reported again with each meta: the same end is the same turn.
            if list.contains(where: { !$0.live && $0.end == turn.end }) { continue }
            if let index = nearest(in: list, to: turn.end, live: true) {
                list[index].paired = true
                list.append(Mark(end: turn.end, live: false, paired: true))
                continue
            }
            list.append(Mark(end: turn.end, live: false, paired: false))
            fresh.append(turn)
        }
        if !list.isEmpty { marks[session] = list }
        return fresh
    }

    /// The closest unpaired mark from the other side, within the time that makes it the same turn.
    private func nearest(in list: [Mark], to end: Date, live: Bool) -> Int? {
        list.indices
            .filter { list[$0].live == live && !list[$0].paired && abs(list[$0].end.timeIntervalSince(end)) <= Self.sameTurn }
            .min { abs(list[$0].end.timeIntervalSince(end)) < abs(list[$1].end.timeIntervalSince(end)) }
    }

    private mutating func prune(now: Date) {
        marks = marks.compactMapValues { list in
            let kept = list.filter { now.timeIntervalSince($0.end) < Self.kept }
            return kept.isEmpty ? nil : kept
        }
    }
}
