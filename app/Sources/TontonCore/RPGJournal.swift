import Foundation

/// What the hero screens show about recent work: today's XP, the streak and the journal. Mirrors shared/rpg-journal.ts.
extension RPG {
    public struct Today: Equatable, Sendable {
        /// The UTC day these numbers are for.
        public let day: String
        public let xp: Int
        /// Days in a row with a turn, ending today, or yesterday until today's first turn.
        public let streak: Int
        /// XP per UTC hour of the day, from the receipts that carry a time.
        public let hours: [Int]
    }

    public struct JournalEntry: Equatable, Identifiable, Sendable {
        public let id: String
        public let kind: Kind
        public let xp: Int
        public let sparks: Int
        public let day: String
        public let at: String?
        public let seconds: Int?
        public let note: String?
    }
}

extension RPG.State {
    public func today(now: Date = Date()) -> RPG.Today {
        let day = RPG.day(now)
        var hours = Array(repeating: 0, count: 24)
        var xp = 0
        for receipt in receipts + gains where receipt.day == day {
            xp += receipt.xp
            if let at = receipt.at, let hour = Int(at.dropFirst(11).prefix(2)), (0..<24).contains(hour) { hours[hour] += receipt.xp }
        }
        let days = Set(gains.filter { $0.kind == .day }.map(\.day))
        var cursor = days.contains(day) ? day : RPG.shift(day, by: -1)
        var streak = 0
        while days.contains(cursor) {
            streak += 1
            cursor = RPG.shift(cursor, by: -1)
        }
        return RPG.Today(day: day, xp: xp, streak: streak, hours: hours)
    }

    /// The last gains, newest first. Older receipts without a time sort by their day. Code-unit order, as in TypeScript.
    public func journal(limit: Int = 20) -> [RPG.JournalEntry] {
        // Keys built once: the journal can sort ten thousand old receipts.
        let keyed = (receipts + gains).filter { $0.xp > 0 }.map {
            (order: Array(($0.at ?? $0.day).utf16), id: Array($0.id.utf16), receipt: $0)
        }
        return
            keyed.sorted { a, b in
                a.order != b.order ? b.order.lexicographicallyPrecedes(a.order) : b.id.lexicographicallyPrecedes(a.id)
            }
            .map(\.receipt)
            .prefix(max(0, limit))
            .map {
                .init(id: $0.id, kind: $0.kind, xp: $0.xp, sparks: $0.sparks, day: $0.day, at: $0.at, seconds: $0.seconds, note: $0.note)
            }
    }
}
