import Foundation

/// Settings › Usage as a CSV file: one row per day, machine, project and tool, for a spreadsheet. RFC 4180: a header row,
/// CRLF line ends, quotes around fields that need them. Numbers use a dot whatever the Mac's language, so every
/// spreadsheet reads them the same.
public enum UsageExport {
    public enum Range: String, CaseIterable, Identifiable, Sendable {
        case lastWeek, lastMonthDays, thisMonth, lastMonth, everything

        public var id: String { rawValue }

        public var label: String {
            switch self {
            case .lastWeek: "Last 7 days"
            case .lastMonthDays: "Last 30 days"
            case .thisMonth: "This month"
            case .lastMonth: "Last month"
            case .everything: "Everything"
            }
        }

        /// The first and last day keys it covers (`2026-10-01`), nil for everything. Keys sort like the dates.
        public func days(until now: Date = Date(), calendar: Calendar = .current) -> ClosedRange<String>? {
            let today = calendar.startOfDay(for: now)
            func back(_ days: Int) -> String? {
                calendar.date(byAdding: .day, value: -days, to: today).map { UsageHistory.day($0, calendar: calendar) }
            }
            let thisMonth = calendar.dateInterval(of: .month, for: today)?.start ?? today
            switch self {
            case .lastWeek: return back(6).map { $0...UsageHistory.day(today, calendar: calendar) }
            case .lastMonthDays: return back(29).map { $0...UsageHistory.day(today, calendar: calendar) }
            case .thisMonth: return UsageHistory.day(thisMonth, calendar: calendar)...UsageHistory.day(today, calendar: calendar)
            case .lastMonth:
                guard let start = calendar.date(byAdding: .month, value: -1, to: thisMonth),
                    let end = calendar.date(byAdding: .day, value: -1, to: thisMonth)
                else { return nil }
                return UsageHistory.day(start, calendar: calendar)...UsageHistory.day(end, calendar: calendar)
            case .everything: return nil
            }
        }
    }

    static let header = [
        "date", "machine", "project", "tool", "cost_usd", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
    ]

    /// The rows of `range`, by day then machine, project and tool. Only a header when nothing was recorded then.
    public static func csv(_ history: UsageHistory, range: Range, until now: Date = Date(), calendar: Calendar = .current) -> String {
        let days = range.days(until: now, calendar: calendar)
        let entries = history.entries
            .filter { days?.contains($0.day) ?? true }
            .sorted { ($0.day, $0.machine, $0.project, $0.toolName) < ($1.day, $1.machine, $1.project, $1.toolName) }
        let rows = entries.map { entry in
            [
                entry.day, entry.machine, entry.project, entry.toolName, String(format: "%.4f", entry.costUSD), String(entry.tokens.input),
                String(entry.tokens.output), String(entry.tokens.cacheRead), String(entry.tokens.cacheWrite),
            ]
        }
        return ([header] + rows).map { $0.map(field).joined(separator: ",") + "\r\n" }.joined()
    }

    /// `tonton-usage-2026-10.csv`, `tonton-usage-2026-10-20-to-2026-10-26.csv`, `tonton-usage.csv`.
    public static func fileName(_ range: Range, until now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let days = range.days(until: now, calendar: calendar) else { return "tonton-usage.csv" }
        if range == .thisMonth || range == .lastMonth { return "tonton-usage-\(days.lowerBound.prefix(7)).csv" }
        return "tonton-usage-\(days.lowerBound)-to-\(days.upperBound).csv"
    }

    /// Quoted when it holds a comma, a quote or a line break. A name that starts like a formula gets a `'` first, so a
    /// spreadsheet shows it instead of running it.
    static func field(_ value: String) -> String {
        let safe = ["=", "+", "-", "@", "\t", "\r"].contains { value.hasPrefix($0) } ? "'" + value : value
        guard safe.contains(where: { $0 == "," || $0 == "\"" || $0 == "\n" || $0 == "\r" || $0 == "\r\n" }) else { return safe }
        return "\"" + safe.replacingOccurrences(of: "\"", with: "\"\"") + "\""
    }
}
