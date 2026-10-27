import Foundation

/// When a 5-hour window will be used up at the current pace, from the readings the sessions report. Each window, told
/// apart by its reset time, keeps the last half hour of readings: the pace is how much it rose over that time.
public struct LimitForecast: Equatable, Sendable {
    struct Reading: Equatable, Sendable {
        let at: Date
        let percent: Double
    }

    private var readings: [Date: [Reading]] = [:]

    /// The pace is read over this much time, and needs at least `shortest` of it to say anything.
    static let span: TimeInterval = 30 * 60
    static let shortest: TimeInterval = 5 * 60

    public init() {}

    /// Keeps a reading of each window still running. Sessions on the same plan report the same window.
    public mutating func record(_ limits: [UsageLimit?], at now: Date = Date()) {
        for limit in limits.compactMap({ $0 }) where limit.resetsAt > now {
            var list = readings[limit.resetsAt] ?? []
            // Sessions repeat the same figure every few seconds: a new reading only when it moves or a minute went by.
            if let last = list.last, last.percent == limit.usedPercent, now.timeIntervalSince(last.at) < 60 { continue }
            list.append(Reading(at: now, percent: limit.usedPercent))
            readings[limit.resetsAt] = list
        }
        readings = readings.filter { $0.key > now }.mapValues { $0.filter { now.timeIntervalSince($0.at) <= Self.span } }
    }

    /// When the window reaches 100 % if usage keeps rising like in the last half hour. Nil when it isn't rising, when it
    /// would reset first, or when it is already full.
    public func runsOut(_ limit: UsageLimit, at now: Date = Date()) -> Date? {
        guard limit.usedPercent < 100, limit.resetsAt > now,
            let list = readings[limit.resetsAt]?.filter({ now.timeIntervalSince($0.at) <= Self.span }),
            let first = list.first, let last = list.last
        else { return nil }
        let elapsed = last.at.timeIntervalSince(first.at)
        let rise = last.percent - first.percent
        guard elapsed >= Self.shortest, rise > 0 else { return nil }
        let end = now.addingTimeInterval((100 - limit.usedPercent) / (rise / elapsed))
        return end < limit.resetsAt ? end : nil
    }
}
