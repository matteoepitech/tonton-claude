import Foundation

/// When Claude works, hour by hour, for the heat map of Settings › Usage. Built on this Mac from the tasks it sees finish,
/// like Wrapped, and kept for a few months.
public struct BusyHours: Codable, Equatable, Sendable {
    /// Seconds worked in each of the 24 hours of a day, keyed by `2026-10-26` in this Mac's time zone.
    public private(set) var days: [String: [TimeInterval]] = [:]

    /// 13 weeks: each weekday counts the same number of times.
    public static let keptDays = 91
    /// A longer task is more likely a clock change or a sleeping Mac than work: only its end counts.
    static let longestTask: TimeInterval = 86400

    public typealias Row = (weekday: Int, hours: [TimeInterval])

    public init() {}

    /// A task worked `seconds` until `end`: each hour it spanned gets its share.
    public mutating func worked(_ seconds: TimeInterval, until end: Date, calendar: Calendar = .current) {
        guard seconds > 0, seconds.isFinite else { return }
        var cursor = end.addingTimeInterval(-min(seconds, Self.longestTask))
        while cursor < end, let hour = calendar.dateInterval(of: .hour, for: cursor) {
            let slice = min(hour.end, end).timeIntervalSince(cursor)
            let key = UsageHistory.day(cursor, calendar: calendar)
            // A day from a damaged file starts over rather than crash.
            var hours = days[key].flatMap { $0.count == 24 ? $0 : nil } ?? Array(repeating: 0, count: 24)
            hours[calendar.component(.hour, from: cursor)] += slice
            days[key] = hours
            cursor = hour.end
        }
        prune(at: end, calendar: calendar)
    }

    /// Seconds per weekday and hour over the `count` days up to `now`: one row per weekday, in the calendar's order
    /// (Monday first in most of Europe), with `weekday` its number as `Calendar` counts them (1 for Sunday).
    public func grid(days count: Int = keptDays, until now: Date = Date(), calendar: Calendar = .current) -> [Row] {
        var rows = [Int: [TimeInterval]]()
        let today = calendar.startOfDay(for: now)
        for offset in 0..<count {
            guard let date = calendar.date(byAdding: .day, value: -offset, to: today),
                let hours = days[UsageHistory.day(date, calendar: calendar)], hours.count == 24
            else { continue }
            let weekday = calendar.component(.weekday, from: date)
            rows[weekday] = zip(rows[weekday] ?? Array(repeating: 0, count: 24), hours).map { $0 + $1 }
        }
        return (0..<7).map { index in
            let weekday = (calendar.firstWeekday - 1 + index) % 7 + 1
            return (weekday, rows[weekday] ?? Array(repeating: 0, count: 24))
        }
    }

    /// The weekday and hour with the most work in `grid`, nil when it has none.
    public static func busiest(_ grid: [Row]) -> (weekday: Int, hour: Int)? {
        let cells = grid.flatMap { row in row.hours.enumerated().map { (weekday: row.weekday, hour: $0.offset, seconds: $0.element) } }
        guard let top = cells.max(by: { $0.seconds < $1.seconds }), top.seconds > 0 else { return nil }
        return (top.weekday, top.hour)
    }

    private mutating func prune(at now: Date, calendar: Calendar) {
        guard let oldest = calendar.date(byAdding: .day, value: -(Self.keptDays - 1), to: calendar.startOfDay(for: now)) else { return }
        let cutoff = UsageHistory.day(oldest, calendar: calendar)
        // `yyyy-MM-dd` sorts like the dates it names.
        days = days.filter { $0.key >= cutoff }
    }
}
