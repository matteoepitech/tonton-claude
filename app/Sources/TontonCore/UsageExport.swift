import Foundation

/// Settings › Usage as a CSV file: one row per day, machine and project, for a spreadsheet or an expense report.
public enum UsageExport {
    /// The days a CSV covers, up to today.
    public enum Range: String, CaseIterable, Identifiable, Sendable {
        case week, month, thisMonth, lastMonth, all

        public var id: String { rawValue }

        public var label: String {
            switch self {
            case .week: String(core: "Last 7 days")
            case .month: String(core: "Last 30 days")
            case .thisMonth: String(core: "This month")
            case .lastMonth: String(core: "Last month")
            case .all: String(core: "Everything recorded")
            }
        }

        /// The first and last days, `2026-10-01`, both included. Nil for everything.
        public func days(until now: Date = Date(), calendar: Calendar = .current) -> (first: String, last: String)? {
            let today = calendar.startOfDay(for: now)
            func day(_ offset: Int, from date: Date = today) -> String {
                UsageHistory.day(calendar.date(byAdding: .day, value: offset, to: date) ?? date, calendar: calendar)
            }
            let monthStart = calendar.dateInterval(of: .month, for: today)?.start ?? today
            switch self {
            case .week: return (day(-6), day(0))
            case .month: return (day(-29), day(0))
            case .thisMonth: return (day(0, from: monthStart), day(0))
            case .lastMonth:
                let previous = calendar.date(byAdding: .month, value: -1, to: monthStart) ?? monthStart
                return (day(0, from: previous), day(-1, from: monthStart))
            case .all: return nil
            }
        }

        /// `tonton-usage-2026-10-01-to-2026-10-27.csv`.
        public func fileName(until now: Date = Date(), calendar: Calendar = .current) -> String {
            guard let days = days(until: now, calendar: calendar) else { return "tonton-usage.csv" }
            return "tonton-usage-\(days.first)-to-\(days.last).csv"
        }
    }

    static let header = [
        "day", "machine", "project", "tool", "cost_usd", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
    ]

    /// Oldest day first, then by machine and project.
    public static func csv(
        _ history: UsageHistory, range: Range, until now: Date = Date(), calendar: Calendar = .current
    ) -> String {
        let bounds = range.days(until: now, calendar: calendar)
        let rows = history.entries
            .filter { entry in bounds.map { entry.day >= $0.first && entry.day <= $0.last } ?? true }
            .sorted { ($0.day, $0.machine, $0.project) < ($1.day, $1.machine, $1.project) }
            .map { entry in
                [
                    entry.day, entry.machine, entry.project, entry.toolName, String(format: "%.4f", entry.costUSD),
                    String(entry.tokens.input), String(entry.tokens.output),
                    String(entry.tokens.cacheRead), String(entry.tokens.cacheWrite),
                ]
            }
        return ([header] + rows).map { $0.map(field).joined(separator: ",") }.joined(separator: "\r\n") + "\r\n"
    }

    /// Quoted when it holds a comma, a quote or a line break (RFC 4180). A project named `=HYPERLINK(…)` would run as a
    /// formula when the file is opened in a spreadsheet: a leading apostrophe keeps it text.
    static func field(_ value: String) -> String {
        let safe = value.first.map { "=+-@\t\r".contains($0) } == true ? "'" + value : value
        guard safe.contains(where: { ",\"\r\n".contains($0) }) else { return safe }
        return "\"" + safe.replacingOccurrences(of: "\"", with: "\"\"") + "\""
    }
}
