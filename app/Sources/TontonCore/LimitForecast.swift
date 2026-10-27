import Foundation

/// When the 5-hour window runs out at the current pace, from the readings the sessions' status lines sent lately. The
/// window is Claude's, per Claude account: readings with the same reset time belong to the same window, so a new window
/// starts a new history and two accounts never mix. Claude Code only: OpenCode has no plan limits.
public struct LimitHistory: Equatable, Sendable {
    /// The pace is read over this much of the recent past.
    public static let pace: TimeInterval = 60 * 60
    /// Less than this between the first and the last reading says nothing about a pace.
    public static let minimumSpan: TimeInterval = 10 * 60
    /// A last reading older than this is stale: the sessions may have stopped since.
    public static let maximumAge: TimeInterval = 15 * 60
    /// "Around 15:40": the estimate is rounded to this.
    public static let rounding: TimeInterval = 5 * 60
    static let maxReadings = 120

    struct Reading: Equatable, Sendable {
        let percent: Double
        let at: Date
    }

    /// Readings per window, by its reset time to the minute.
    private var windows: [Date: [Reading]] = [:]

    public init() {}

    /// Keeps a reading. The same percent read again keeps the first time it was read: that is when it was reached.
    public mutating func record(_ limit: UsageLimit, at now: Date = Date()) {
        let window = Self.window(limit)
        var readings = windows[window] ?? []
        if let last = readings.last {
            if last.percent == limit.usedPercent { return }
            // Usage never goes down within a window: what came before is from something else.
            if limit.usedPercent < last.percent { readings = [] }
        }
        readings.append(Reading(percent: limit.usedPercent, at: now))
        windows[window] = Array(readings.filter { now.timeIntervalSince($0.at) <= 2 * Self.pace }.suffix(Self.maxReadings))
        windows = windows.filter { $0.key > now }
    }

    public enum Forecast: Equatable, Sendable {
        /// At this pace, the limit is reached then, before the window resets.
        case runsOut(Date)
        /// At this pace, the window resets first.
        case lastsUntilReset
    }

    /// Nil without a pace to go by: too few readings, too short a span, no growth, or a limit already reached.
    public func forecast(for limit: UsageLimit, at now: Date = Date()) -> Forecast? {
        guard limit.resetsAt > now, limit.usedPercent < 100 else { return nil }
        let recent = (windows[Self.window(limit)] ?? []).filter { now.timeIntervalSince($0.at) <= Self.pace }
        guard recent.count >= 2, let first = recent.first, let last = recent.last,
            last.at.timeIntervalSince(first.at) >= Self.minimumSpan, now.timeIntervalSince(last.at) <= Self.maximumAge,
            let slope = Self.slope(recent), slope > 0
        else { return nil }
        let end = last.at.addingTimeInterval((100 - last.percent) / slope)
        guard end < limit.resetsAt else { return .lastsUntilReset }
        let rounded = Date(timeIntervalSince1970: (end.timeIntervalSince1970 / Self.rounding).rounded() * Self.rounding)
        return .runsOut(max(rounded, now))
    }

    /// Percent per second, by least squares over the readings.
    private static func slope(_ readings: [Reading]) -> Double? {
        let origin = readings[0].at
        let points = readings.map { (x: $0.at.timeIntervalSince(origin), y: $0.percent) }
        let n = Double(points.count)
        let meanX = points.map(\.x).reduce(0, +) / n
        let meanY = points.map(\.y).reduce(0, +) / n
        let spread = points.map { ($0.x - meanX) * ($0.x - meanX) }.reduce(0, +)
        guard spread > 0 else { return nil }
        return points.map { ($0.x - meanX) * ($0.y - meanY) }.reduce(0, +) / spread
    }

    private static func window(_ limit: UsageLimit) -> Date {
        Date(timeIntervalSince1970: (limit.resetsAt.timeIntervalSince1970 / 60).rounded() * 60)
    }
}

extension LimitHistory.Forecast {
    /// `Runs out around 15:40`, or `Lasts until the reset`.
    public func text(timeZone: TimeZone = .current, locale: Locale = .current) -> String {
        switch self {
        case .runsOut(let date):
            let formatter = DateFormatter()
            formatter.timeZone = timeZone
            formatter.locale = locale
            formatter.dateStyle = .none
            formatter.timeStyle = .short
            return "Runs out around \(formatter.string(from: date))"
        case .lastsUntilReset:
            return "Lasts until the reset"
        }
    }
}
