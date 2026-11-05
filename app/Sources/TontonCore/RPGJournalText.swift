import Foundation

/// The words of the hero screen's journal and the hours of its day, kept out of the views so they can be tested.
extension RPG.JournalEntry {
    /// Why the XP came, after "+18 · ": "13 minutes of work in tonton-claude", "pushed main", "checklist task".
    public var reason: String {
        switch kind {
        case .turn:
            let minutes = (seconds ?? 0) / 60
            if minutes < 1 { return String(core: "answered prompt") }
            if let note { return String(core: "\(minutes) minutes of work in \(note)") }
            return String(core: "\(minutes) minutes of work")
        case .push:
            if let note { return String(core: "pushed \(note)") }
            return String(core: "pushed commits")
        case .day: return String(core: "first turn of the day")
        case .task: return String(core: "checklist task")
        case .poolTask: return String(core: "pool task")
        case .review: return String(core: "accepted review")
        case .encounter: return String(core: "arena fight")
        case .boss: return String(core: "arena boss")
        }
    }

    /// When it was earned. Receipts from before times were kept only have their day: noon UTC places them on it.
    public var date: Date? {
        if let at, let date = RPG.date(at) { return date }
        return ISO8601DateFormatter().date(from: day + "T12:00:00Z")
    }
}

extension RPG {
    /// A receipt's time in any form `utc` takes: minutes only, seconds, or fractions of a second. Claude Code's times carry
    /// milliseconds, which the default ISO 8601 reader refuses: every gain of the journal fell back on noon UTC.
    static func date(_ at: String) -> Date? {
        guard utc(at) else { return nil }
        var whole = at.replacingOccurrences(of: #"\.[0-9]+Z$"#, with: "Z", options: .regularExpression)
        if whole.count == 17 { whole = String(whole.dropLast()) + ":00Z" }
        return ISO8601DateFormatter().date(from: whole)
    }
}

extension RPG.Today {
    /// Midnight UTC of the day, where its first hour bar starts. The bars stay in UTC order, as the website draws them,
    /// so time runs left to right; each one is labelled with the local time it starts at.
    public var start: Date? { ISO8601DateFormatter().date(from: day + "T00:00:00Z") }

    /// The bar `date` falls in, if it is in this day.
    public func hour(of date: Date) -> Int? {
        guard let start else { return nil }
        let hour = Int((date.timeIntervalSince(start) / 3600).rounded(.down))
        return (0..<24).contains(hour) ? hour : nil
    }
}

extension RPG.State {
    /// Whether today's first turn has been counted, so the streak lights today rather than ending yesterday.
    public func playedToday(now: Date = Date()) -> Bool {
        let day = RPG.day(now)
        return gains.contains { $0.kind == .day && $0.day == day }
    }
}
