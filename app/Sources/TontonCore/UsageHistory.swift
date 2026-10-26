import Foundation

/// Cost and tokens per day, machine and project, kept on this Mac for Settings › Usage. Sessions only report running
/// totals, so each reading adds what grew since the previous reading of the same session.
public struct UsageHistory: Codable, Equatable, Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        /// `2026-10-26`, in this Mac's time zone.
        public let day: String
        public let machine: String
        public let project: String
        public var costUSD: Double
        public var tokens: TokenCounts
    }

    /// The last totals of a session.
    struct Reading: Codable, Equatable, Sendable {
        var costUSD: Double
        var tokens: TokenCounts
        var seenAt: Date
    }

    public private(set) var entries: [Entry] = []
    private(set) var readings: [String: Reading] = [:]

    /// Readings of sessions not seen for this long are forgotten: their next totals would count again.
    static let readingLifetime: TimeInterval = 30 * 86400
    /// Long enough for a yearly recap.
    static let keptDays = 400

    public init() {}

    /// Adds what each session spent since its last reading to today. A session seen for the first time counts in full,
    /// on the day it started.
    public mutating func record(_ sessions: [SessionSummary], at now: Date = Date(), calendar: Calendar = .current) {
        for session in sessions where session.costUSD != nil || session.tokens != nil {
            let cost = session.costUSD ?? 0
            let tokens = session.tokens ?? TokenCounts()
            let previous = readings[session.id]
            readings[session.id] = Reading(costUSD: cost, tokens: tokens, seenAt: now)
            // Totals only go down when Claude Code starts over (a replaced transcript): the new ones are the baseline.
            let added = UsageDelta(
                costUSD: max(0, cost - (previous?.costUSD ?? 0)),
                tokens: TokenCounts(
                    input: max(0, tokens.input - (previous?.tokens.input ?? 0)),
                    output: max(0, tokens.output - (previous?.tokens.output ?? 0)),
                    cacheRead: max(0, tokens.cacheRead - (previous?.tokens.cacheRead ?? 0)),
                    cacheWrite: max(0, tokens.cacheWrite - (previous?.tokens.cacheWrite ?? 0))))
            guard added.costUSD > 0 || added.tokens != TokenCounts() else { continue }
            let day = Self.day(previous == nil ? min(session.startedAt, now) : now, calendar: calendar)
            add(added, day: day, machine: session.machine, project: session.project)
        }
        prune(at: now, calendar: calendar)
    }

    /// Totals per day for the `count` days up to `now`, oldest first, with the days without usage at zero.
    public func daily(_ count: Int, until now: Date = Date(), calendar: Calendar = .current) -> [(day: Date, entries: [Entry])] {
        (0..<count).reversed().compactMap { offset in
            guard let date = calendar.date(byAdding: .day, value: -offset, to: calendar.startOfDay(for: now)) else { return nil }
            let day = Self.day(date, calendar: calendar)
            return (date, entries.filter { $0.day == day })
        }
    }

    /// Entries of the `count` days up to `now` grouped by `key` (a machine or a project), the costliest first.
    public func totals(
        by key: KeyPath<Entry, String>, days count: Int, until now: Date = Date(), calendar: Calendar = .current
    ) -> [(name: String, costUSD: Double, tokens: TokenCounts)] {
        let recent = daily(count, until: now, calendar: calendar).flatMap(\.entries)
        let groups = Dictionary(grouping: recent) { $0[keyPath: key] }
        return groups.map { name, entries in
            (name, entries.map(\.costUSD).reduce(0, +), entries.map(\.tokens).reduce(TokenCounts(), +))
        }
        .sorted { $0.costUSD != $1.costUSD ? $0.costUSD > $1.costUSD : $0.name < $1.name }
    }

    /// What was spent on the day of `date`.
    public func spent(on date: Date = Date(), calendar: Calendar = .current) -> Double {
        let day = Self.day(date, calendar: calendar)
        return entries.filter { $0.day == day }.map(\.costUSD).reduce(0, +)
    }

    private mutating func add(_ delta: UsageDelta, day: String, machine: String, project: String) {
        if let index = entries.firstIndex(where: { $0.day == day && $0.machine == machine && $0.project == project }) {
            entries[index].costUSD += delta.costUSD
            entries[index].tokens = entries[index].tokens + delta.tokens
        } else {
            entries.append(Entry(day: day, machine: machine, project: project, costUSD: delta.costUSD, tokens: delta.tokens))
        }
    }

    private mutating func prune(at now: Date, calendar: Calendar) {
        readings = readings.filter { now.timeIntervalSince($0.value.seenAt) < Self.readingLifetime }
        guard let oldest = calendar.date(byAdding: .day, value: -Self.keptDays, to: now) else { return }
        let cutoff = Self.day(oldest, calendar: calendar)
        entries.removeAll { $0.day < cutoff }
    }

    /// The key of `date`'s day in the history.
    public static func day(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }
}

/// The daily budget of Settings › General: one alert, the first time a day's spending goes past it.
public enum DailyBudget {
    public static func shouldAlert(spent: Double, budget: Double, lastAlertDay: String, today: String) -> Bool {
        budget > 0 && spent >= budget && lastAlertDay != today
    }
}

private struct UsageDelta {
    let costUSD: Double
    let tokens: TokenCounts
}
