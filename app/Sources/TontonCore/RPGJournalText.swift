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
        if let at, let date = ISO8601DateFormatter().date(from: at) { return date }
        return ISO8601DateFormatter().date(from: day + "T12:00:00Z")
    }
}

extension RPG.Today {
    /// `hours` moved from UTC to the clock of a zone `offset` seconds ahead of it, so the bar under "3 PM" is the user's
    /// 3 PM. Half-hour zones round down to the hour.
    public func localHours(offset: Int) -> [Int] {
        guard hours.count == 24 else { return Array(repeating: 0, count: 24) }
        let shift = Int((Double(offset) / 3600).rounded(.down))
        return (0..<24).map { local in hours[((local - shift) % 24 + 24) % 24] }
    }
}

extension RPG.State {
    /// Whether today's first turn has been counted, so the streak lights today rather than ending yesterday.
    public func playedToday(now: Date = Date()) -> Bool {
        let day = String(ISO8601DateFormatter().string(from: now).prefix(10))
        return gains.contains { $0.kind == .day && $0.day == day }
    }
}
