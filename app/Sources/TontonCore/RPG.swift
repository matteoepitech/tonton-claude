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
    public enum Kind: String, Codable, Sendable {
        case task, poolTask, review, encounter, boss
        public var xp: Int {
            switch self {
            case .task: 10;
            case .poolTask: 50;
            case .review: 20;
            case .encounter: 15;
            case .boss: 75
            }
        }
        public var sparks: Int {
            switch self {
            case .task: 1;
            case .poolTask: 5;
            case .review: 2;
            case .encounter: 2;
            case .boss: 10
            }
        }
        var combat: Bool { self == .encounter || self == .boss }
    }
    public struct Reward: Codable, Equatable, Sendable {
        public let id: String
        public let kind: Kind
        public let day: String
        public init(kind: Kind, source: String, at: String) {
            self.id = SHA256.hash(data: Data("\(kind.rawValue)\n\(source)".utf8)).map { String(format: "%02x", $0) }.joined()
            self.kind = kind
            self.day = String(at.prefix(10))
        }
        var valid: Bool {
            id.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
                && day.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil
                && ISO8601DateFormatter().date(from: day + "T00:00:00Z") != nil
        }
    }
    public struct Receipt: Codable, Equatable, Sendable {
        public let id: String
        public let kind: Kind
        public let day: String
        public let xp: Int
        public let sparks: Int
    }
    public struct State: Codable, Equatable, Sendable {
        public var version = RPG.version
        public var xp = 0
        public var sparks = 0
        public var receipts: [Receipt] = []
        public var owned: [String] = []
        public var equipped: [String: String] = [:]
        public var boosters: [String] = []
        public var openings: [String: Opening] = [:]
        public var upgrades: [String: Int] = [:]
        public init() {}
        public var level: Int { RPG.level(xp) }
        public var progress: Double {
            if level == 100 { return 1 }
            return Double(xp - RPG.threshold(level)) / Double(RPG.threshold(level + 1) - RPG.threshold(level))
        }
        public func validate() throws {
            let safe = { (n: Int) in n >= 0 && n <= 9_007_199_254_740_991 }
            guard version == RPG.version, safe(xp), safe(sparks), receipts.count <= RPG.receiptLimit,
                receipts.allSatisfy({
                    safe($0.xp) && $0.xp <= $0.kind.xp && safe($0.sparks) && $0.sparks <= $0.kind.sparks
                        && $0.id.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
                        && ISO8601DateFormatter().date(from: $0.day + "T00:00:00Z") != nil
                }),
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
        public mutating func award(_ reward: Reward) throws {
            guard reward.valid else { throw Failure.invalidReward }
            if receipts.contains(where: { $0.id == reward.id }) { return }
            guard receipts.count < RPG.receiptLimit else { throw Failure.receiptLimit }
            let spent = receipts.filter { $0.day == reward.day && $0.kind.combat == reward.kind.combat }.reduce(0) { $0 + $1.xp }
            let gain = min(reward.kind.xp, max(0, (reward.kind.combat ? 300 : 1000) - spent))
            let resource = reward.kind.sparks * gain / reward.kind.xp
            let before = level
            xp += gain
            sparks += resource
            receipts.append(Receipt(id: reward.id, kind: reward.kind, day: reward.day, xp: gain, sparks: resource))
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
