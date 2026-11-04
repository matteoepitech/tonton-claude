import CryptoKit
import Foundation

/// Tonton's account-wide economy. Mirrors shared/rpg.ts; all stored values are sealed before transport.
public enum RPG {
    public static let version = 1
    public static let receiptLimit = 10_000
    public enum Failure: Error { case invalidState, invalidReward, receiptLimit, lockedItem, conflict }
    public enum Slot: String, Codable, CaseIterable, Sendable {
        case skin, hat, accessory, aura, trail
        public var label: String {
            switch self {
            case .skin: String(core: "Skin")
            case .hat: String(core: "Hat")
            case .accessory: String(core: "Accessory")
            case .aura: String(core: "Aura")
            case .trail: String(core: "Trail")
            }
        }
    }
    public enum Rarity: String, Codable, CaseIterable, Sendable {
        case common, uncommon, rare, epic, legendary
        public var label: String {
            switch self {
            case .common: String(core: "Common")
            case .uncommon: String(core: "Uncommon")
            case .rare: String(core: "Rare")
            case .epic: String(core: "Epic")
            case .legendary: String(core: "Legendary")
            }
        }
    }
    public struct Item: Identifiable, Equatable, Sendable {
        public let id: String
        public let slot: Slot
        public let rarity: Rarity
        public let color: UInt32
    }
    public static let catalog: [Item] = Slot.allCases.flatMap { slot in
        Rarity.allCases.enumerated().map { index, rarity in
            Item(
                id: "\(slot.rawValue)-\(rarity.rawValue)", slot: slot, rarity: rarity,
                color: [UInt32(0x71c7a5), 0x66b9ee, 0xb492ff, 0xf38ac8, 0xffcf66][index])
        }
    }
    /// Version 1 kinds live in `receipts`; version 2 kinds (`turn`, `day`, `push`) in `gains`, which version 1 apps ignore.
    public enum Kind: String, Codable, Sendable {
        case task, poolTask, review, encounter, boss, turn, day, push
        /// The most one reward of this kind can earn. A turn depends on its length, a day on the streak.
        public var xp: Int {
            switch self {
            case .task: 10
            case .poolTask: 50
            case .review: 20
            case .encounter: 15
            case .boss: 75
            case .turn: 65
            case .day: 50
            case .push: 15
            }
        }
        public var sparks: Int {
            switch self {
            case .task: 1
            case .poolTask: 5
            case .review: 2
            case .encounter: 2
            case .boss: 10
            case .turn: 6
            case .day: 5
            case .push: 1
            }
        }
        var combat: Bool { self == .encounter || self == .boss }
        public var gain: Bool { self == .turn || self == .day || self == .push }
    }
    /// Rules version 2, the same numbers as `RPG_RULES` in shared/rpg.ts.
    public enum Rules {
        public static let version = 2
        public static let prompt = 5
        public static let shortPrompt = 1
        public static let shortSeconds = 5
        public static let minuteXP = 1
        public static let turnMinutes = 60
        public static let day = 20
        public static let streakDay = 10
        public static let dayMax = 50
        public static let push = 15
        public static let workCap = 1500
        public static let combatCap = 300
        public static let xpPerSpark = 10
        /// Gains older than this many days are refused, so pruned receipts can never be earned again.
        public static let gainHorizon = 21
        /// Gains are kept this many days, longer than the horizon.
        public static let gainDays = 30
        public static let gainsPerDay = 200
    }
    /// Facts about the work, never an amount of XP.
    public struct Reward: Codable, Equatable, Sendable {
        public let id: String
        public let kind: Kind
        public let day: String
        public var at: String?
        public var seconds: Int?
        public var prompted: Bool?
        public var note: String?
        public init(kind: Kind, source: String, at: String, seconds: Int? = nil, prompted: Bool? = nil, note: String? = nil) {
            self.id = SHA256.hash(data: Data("\(kind.rawValue)\n\(source)".utf8)).map { String(format: "%02x", $0) }.joined()
            self.kind = kind
            self.day = String(at.prefix(10))
            self.at = RPG.utc(at) ? at : nil
            self.seconds = seconds.map { min(86_400, max(0, $0)) }
            self.prompted = prompted
            self.note = RPG.note(note)
        }
        var valid: Bool {
            id.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
                && RPG.details(day: day, at: at, seconds: seconds, note: note)
        }
    }
    public struct Receipt: Codable, Equatable, Sendable {
        public let id: String
        public let kind: Kind
        public let day: String
        public let xp: Int
        public let sparks: Int
        public var at: String?
        public var seconds: Int?
        public var note: String?
        public init(id: String, kind: Kind, day: String, xp: Int, sparks: Int, at: String? = nil, seconds: Int? = nil, note: String? = nil)
        {
            self.id = id
            self.kind = kind
            self.day = day
            self.xp = xp
            self.sparks = sparks
            self.at = at
            self.seconds = seconds
            self.note = note
        }
        var valid: Bool {
            let safe = { (n: Int) in n >= 0 && n <= 9_007_199_254_740_991 }
            return safe(xp) && xp <= kind.xp && safe(sparks) && sparks <= kind.sparks
                && id.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
                && RPG.details(day: day, at: at, seconds: seconds, note: note)
        }
    }
    public struct State: Codable, Equatable, Sendable {
        public var version = RPG.version
        public var xp = 0
        public var sparks = 0
        /// Version 1 kinds. Never pruned.
        public var receipts: [Receipt] = []
        /// Version 2 kinds, absent from older documents and pruned after `Rules.gainDays`.
        public var gains: [Receipt] = []
        public var owned: [String] = []
        public var equipped: [String: String] = [:]
        public var boosters: [String] = []
        public var openings: [String: Opening] = [:]
        public var upgrades: [String: Int] = [:]
        public init() {}
        enum CodingKeys: String, CodingKey {
            case version, xp, sparks, receipts, gains, owned, equipped, boosters, openings, upgrades
        }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            version = try c.decode(Int.self, forKey: .version)
            xp = try c.decode(Int.self, forKey: .xp)
            sparks = try c.decode(Int.self, forKey: .sparks)
            receipts = try c.decode([Receipt].self, forKey: .receipts)
            gains = try c.decodeIfPresent([Receipt].self, forKey: .gains) ?? []
            owned = try c.decode([String].self, forKey: .owned)
            equipped = try c.decode([String: String].self, forKey: .equipped)
            boosters = try c.decode([String].self, forKey: .boosters)
            openings = try c.decode([String: Opening].self, forKey: .openings)
            upgrades = try c.decode([String: Int].self, forKey: .upgrades)
        }
        /// A hero without gains encodes as it did in version 1.
        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(version, forKey: .version)
            try c.encode(xp, forKey: .xp)
            try c.encode(sparks, forKey: .sparks)
            try c.encode(receipts, forKey: .receipts)
            if !gains.isEmpty { try c.encode(gains, forKey: .gains) }
            try c.encode(owned, forKey: .owned)
            try c.encode(equipped, forKey: .equipped)
            try c.encode(boosters, forKey: .boosters)
            try c.encode(openings, forKey: .openings)
            try c.encode(upgrades, forKey: .upgrades)
        }
        public var level: Int { RPG.level(xp) }
        public var progress: Double {
            if level == 100 { return 1 }
            return Double(xp - RPG.threshold(level)) / Double(RPG.threshold(level + 1) - RPG.threshold(level))
        }
        public func validate() throws {
            let safe = { (n: Int) in n >= 0 && n <= 9_007_199_254_740_991 }
            guard version == RPG.version, safe(xp), safe(sparks), receipts.count <= RPG.receiptLimit,
                receipts.allSatisfy({ $0.valid && !$0.kind.gain }),
                gains.count <= RPG.receiptLimit, gains.allSatisfy({ $0.valid && $0.kind.gain }),
                [owned, boosters].allSatisfy({ $0.count <= RPG.receiptLimit && $0.allSatisfy { $0.count <= 200 } }),
                equipped.allSatisfy({ Slot(rawValue: $0.key) != nil && $0.value.count <= 200 }),
                openings.count <= RPG.receiptLimit,
                openings.allSatisfy({
                    $0.key.count <= 200 && $0.value.item.count <= 200 && (0...50).contains($0.value.duplicateSparks)
                        && ($0.value.tableVersion == nil || $0.value.tableVersion == 1)
                }),
                upgrades.values.allSatisfy({ (0...10).contains($0) })
            else { throw Failure.invalidState }
        }
        public func item(_ slot: Slot) -> Item? {
            guard let id = equipped[slot.rawValue], owned.contains(id) else { return nil }
            return RPG.catalog.first { $0.id == id && $0.slot == slot }
        }
        /// What a reward earns before the daily cap. Only facts come from the agent; the amounts are here.
        func earned(_ reward: Reward) -> Int {
            switch reward.kind {
            case .turn:
                let seconds = reward.seconds ?? 0
                let prompt = reward.prompted != true ? 0 : seconds < Rules.shortSeconds ? Rules.shortPrompt : Rules.prompt
                return prompt + min(Rules.turnMinutes, seconds / 60) * Rules.minuteXP
            case .day:
                // Only the three days before matter: a fourth day of streak is already at the maximum.
                var streak = 0
                while streak < 3, gains.contains(where: { $0.kind == .day && $0.day == RPG.shift(reward.day, by: -(streak + 1)) }) {
                    streak += 1
                }
                return min(Rules.dayMax, Rules.day + Rules.streakDay * streak)
            case .push: return Rules.push
            default: return reward.kind.xp
            }
        }
        /// `now` decides which gains are too old to earn and which are pruned. A gain that earns nothing leaves no receipt.
        public mutating func award(_ reward: Reward, now: Date = Date()) throws {
            guard reward.valid else { throw Failure.invalidReward }
            if receipts.contains(where: { $0.id == reward.id }) || gains.contains(where: { $0.id == reward.id }) { return }
            var kept = gains
            if reward.kind.gain {
                let today = RPG.day(now)
                if reward.day < RPG.shift(today, by: -Rules.gainHorizon) || reward.day > RPG.shift(today, by: 1) { return }
                if gains.filter({ $0.day == reward.day }).count >= Rules.gainsPerDay { return }
                let oldest = RPG.shift(today, by: -Rules.gainDays)
                kept = gains.filter { $0.day >= oldest }
                guard kept.count < RPG.receiptLimit else { throw Failure.receiptLimit }
            } else {
                guard receipts.count < RPG.receiptLimit else { throw Failure.receiptLimit }
            }
            let spent = (receipts + gains).filter { $0.day == reward.day && $0.kind.combat == reward.kind.combat }.reduce(0) { $0 + $1.xp }
            let gain = min(earned(reward), max(0, (reward.kind.combat ? Rules.combatCap : Rules.workCap) - spent))
            if reward.kind.gain && gain == 0 { return }
            let resource = reward.kind.gain ? gain / Rules.xpPerSpark : reward.kind.sparks * gain / reward.kind.xp
            let before = level
            xp += gain
            sparks += resource
            let receipt = Receipt(
                id: reward.id, kind: reward.kind, day: reward.day, xp: gain, sparks: resource, at: reward.at,
                seconds: reward.kind == .turn ? reward.seconds : nil, note: reward.note)
            if reward.kind.gain {
                gains = kept + [receipt]
            } else {
                receipts.append(receipt)
            }
            if reward.kind == .boss && gain > 0 { boosters.append("boss-v1-\(reward.id)") }
            if level > before {
                for reached in (before + 1)...level {
                    boosters.append("level-\(reached)")
                    if reached <= 6 {
                        let item = "\(Slot.allCases[reached - 2].rawValue)-common"
                        if !owned.contains(item) { owned.append(item) }
                    }
                }
            }
        }
        public mutating func equip(_ id: String?, in slot: Slot) throws {
            if let id {
                guard owned.contains(id), RPG.catalog.contains(where: { $0.id == id && $0.slot == slot }) else { throw Failure.lockedItem }
            }
            equipped[slot.rawValue] = id
        }

        /// Target rank makes retries safe; the combat client applies the resulting stats.
        public mutating func upgrade(_ stat: String, rank: Int) throws {
            guard ["health", "attack", "movement"].contains(stat), (1...10).contains(rank) else { throw Failure.invalidReward }
            let current = upgrades[stat] ?? 0
            if rank <= current { return }
            guard rank == current + 1, sparks >= rank * 10 else { throw Failure.lockedItem }
            sparks -= rank * 10
            upgrades[stat] = rank
        }

        /// The committed receipt wins over a new candidate from another device. The reveal never rerolls it.
        public mutating func openBooster(_ booster: String, item id: String) throws {
            if openings[booster] != nil { return }
            guard boosters.contains(booster), let item = RPG.catalog.first(where: { $0.id == id }),
                let rarity = Rarity.allCases.firstIndex(of: item.rarity), openings.count < RPG.receiptLimit
            else { throw Failure.lockedItem }
            let duplicate = owned.contains(id) ? [1, 3, 8, 20, 50][rarity] : 0
            sparks += duplicate
            if !owned.contains(id) { owned.append(id) }
            boosters.removeAll { $0 == booster }
            openings[booster] = Opening(item: id, duplicateSparks: duplicate)
        }
    }
    public struct Opening: Codable, Equatable, Sendable {
        public let item: String
        public let duplicateSparks: Int
        public var tableVersion: Int? = 1
    }
    /// A UTC time with minutes, as transcripts and the agent write them. Anything else keeps only its day.
    static func utc(_ at: String) -> Bool {
        at.range(of: #"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,9})?)?Z$"#, options: .regularExpression) != nil
    }
    /// Trimmed and cut on a character to 80 UTF-16 units, as shared/rpg.ts does.
    static func note(_ note: String?) -> String? {
        var kept = ""
        for character in (note ?? "").trimmingCharacters(in: .whitespacesAndNewlines) {
            if kept.utf16.count + String(character).utf16.count > 80 { break }
            kept.append(character)
        }
        return kept.isEmpty ? nil : kept
    }
    static func details(day: String, at: String?, seconds: Int?, note: String?) -> Bool {
        guard day.utf8.count == 10, days(day) != nil else { return false }
        if let at, !utc(at) || !at.hasPrefix(day) { return false }
        if let seconds, !(0...86_400).contains(seconds) { return false }
        if let note, note.utf16.count > 80 { return false }
        return true
    }
    /// Days since 1970-01-01 of a valid "YYYY-MM-DD", with integer calendar math: no formatter on the award path.
    static func days(_ day: String) -> Int? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, (1...12).contains(parts[1]), (1...31).contains(parts[2]) else { return nil }
        let (y, m, d) = (parts[0] - (parts[1] <= 2 ? 1 : 0), parts[1], parts[2])
        let era = (y >= 0 ? y : y - 399) / 400
        let year = y - era * 400
        let dayOfYear = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1
        let count = era * 146_097 + year * 365 + year / 4 - year / 100 + dayOfYear - 719_468
        return civil(count) == day ? count : nil
    }
    /// The "YYYY-MM-DD" of a count of days since 1970-01-01.
    static func civil(_ count: Int) -> String {
        let z = count + 719_468
        let era = (z >= 0 ? z : z - 146_096) / 146_097
        let doe = z - era * 146_097
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let d = doy - (153 * mp + 2) / 5 + 1
        let m = mp + (mp < 10 ? 3 : -9)
        return String(format: "%04d-%02d-%02d", yoe + era * 400 + (m <= 2 ? 1 : 0), m, d)
    }
    /// The UTC day of a moment, "YYYY-MM-DD".
    public static func day(_ date: Date) -> String { civil(Int((date.timeIntervalSince1970 / 86_400).rounded(.down))) }
    /// The UTC day `days` after `day` (before it when negative).
    public static func shift(_ day: String, by days: Int) -> String {
        guard let start = Self.days(day) else { return day }
        return civil(start + days)
    }
    public static func level(_ xp: Int) -> Int {
        let discriminant: Double = 1.0 + 4.0 * Double(max(0, xp)) / 50.0
        let result: Double = (1.0 + discriminant.squareRoot()) / 2.0
        return min(100, Int(result.rounded(.down)))
    }
    public static func threshold(_ level: Int) -> Int { 50 * level * (level - 1) }
}

/// HTTP envelope: only the revision and ciphertext are visible to the relay.
public struct RPGDocument: Codable, Sendable {
    public let rev: Int
    public let blob: String?
}
