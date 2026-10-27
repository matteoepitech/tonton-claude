import Foundation

/// The monthly recap of Settings › Usage: how long Claude worked, the busiest project, the most used tool and the longest
/// session. Built on this Mac from the tasks it sees finish and the tool calls of the conversations it holds.
public struct WrappedLog: Codable, Equatable, Sendable {
    public struct Month: Codable, Equatable, Sendable {
        /// From each prompt to its answer, approvals and questions included.
        public var workedSeconds: TimeInterval = 0
        public var projectSeconds: [String: TimeInterval] = [:]
        public var toolCalls: [String: Int] = [:]
        var sessionSeconds: [String: TimeInterval] = [:]
        var sessionProjects: [String: String] = [:]
        /// The calls already counted: the same conversations come back after each launch, from the relay or the transcripts.
        var counted: Set<String> = []
    }

    /// A name and how much of something it got: seconds or calls.
    public struct Ranked: Equatable, Sendable {
        public let name: String
        public let value: Double
    }

    public struct Recap: Equatable, Sendable {
        /// `2026-10`.
        public let month: String
        public let worked: TimeInterval
        public let topProject: Ranked?
        public let topTool: Ranked?
        public let toolCalls: Int
        /// The project of the session that worked the longest, and for how long.
        public let longestSession: Ranked?
    }

    /// Keyed by `2026-10`.
    public private(set) var months: [String: Month] = [:]

    /// A year back, and the month it started.
    static let keptMonths = 13

    public init() {}

    /// A session finished a task after working `seconds`. Counts in the month it finished.
    public mutating func worked(
        _ seconds: TimeInterval, session: String, project: String, at now: Date = Date(), calendar: Calendar = .current
    ) {
        guard seconds > 0 else { return }
        let key = Self.month(now, calendar: calendar)
        var month = months[key] ?? Month()
        month.workedSeconds += seconds
        month.projectSeconds[project, default: 0] += seconds
        month.sessionSeconds[session, default: 0] += seconds
        month.sessionProjects[session] = project
        months[key] = month
        prune()
    }

    /// Counts the tool calls not seen before, in the month Claude made them. True when something was added.
    @discardableResult
    public mutating func count(_ entries: [String: [Entry]], calendar: Calendar = .current) -> Bool {
        var added = false
        for (session, list) in entries {
            for entry in list where entry.kind == .tool {
                guard let name = entry.name, !name.isEmpty, let date = ISO8601.parse(entry.ts) else { continue }
                // Tool use ids come from the API, so a call has the same one in the relay's copy and in the transcript.
                let id = entry.toolUseId.flatMap { $0.isEmpty ? nil : $0 } ?? "\(session)/\(entry.id)"
                let key = Self.month(date, calendar: calendar)
                guard months[key]?.counted.contains(id) != true else { continue }
                var month = months[key] ?? Month()
                month.counted.insert(id)
                month.toolCalls[name, default: 0] += 1
                months[key] = month
                added = true
            }
        }
        if added { prune() }
        return added
    }

    /// The months with something to show, the latest first.
    public var recorded: [String] {
        months.filter { $0.value.workedSeconds > 0 || !$0.value.toolCalls.isEmpty }.keys.sorted(by: >)
    }

    public func recap(_ key: String) -> Recap? {
        guard let month = months[key], month.workedSeconds > 0 || !month.toolCalls.isEmpty else { return nil }
        let longest = Self.top(month.sessionSeconds)
        return Recap(
            month: key, worked: month.workedSeconds, topProject: Self.top(month.projectSeconds),
            topTool: Self.top(month.toolCalls.mapValues(Double.init)), toolCalls: month.toolCalls.values.reduce(0, +),
            longestSession: longest.map { Ranked(name: month.sessionProjects[$0.name] ?? "", value: $0.value) })
    }

    private static func top(_ values: [String: Double]) -> Ranked? {
        values.max { $0.value != $1.value ? $0.value < $1.value : $0.key > $1.key }.map { Ranked(name: $0.key, value: $0.value) }
    }

    private mutating func prune() {
        let kept = Set(months.keys.sorted(by: >).prefix(Self.keptMonths))
        months = months.filter { kept.contains($0.key) }
    }

    /// The key of `date`'s month.
    public static func month(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month], from: date)
        return String(format: "%04d-%02d", parts.year ?? 0, parts.month ?? 0)
    }

    /// `October 2026`.
    public static func title(_ key: String, locale: Locale = .current) -> String {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
        guard parts.count == 2, let date = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: 15)) else { return key }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = calendar.timeZone
        formatter.setLocalizedDateFormatFromTemplate("MMMM yyyy")
        return formatter.string(from: date)
    }

    /// `42 min`, `12 h 05`.
    public static func duration(_ seconds: TimeInterval) -> String {
        let minutes = Int((seconds / 60).rounded())
        return minutes < 60
            ? String(core: "\(minutes) min") : String(core: "\(minutes / 60) h \(String(format: "%02d", minutes % 60))")
    }
}

extension UsageHistory {
    /// What was spent in a month of `WrappedLog`.
    public func spent(inMonth key: String) -> Double {
        entries.filter { $0.day.hasPrefix(key + "-") }.map(\.costUSD).reduce(0, +)
    }
}
