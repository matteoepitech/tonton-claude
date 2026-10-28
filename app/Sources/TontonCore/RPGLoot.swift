import Foundation

/// Earned loot and combat stats, matching shared/rpg-loot.ts. Draw before a retryable transaction.
extension RPG {
    public struct Stats: Equatable, Sendable {
        public let health: Double
        public let attack: Double
        public let movement: Double
        public init(hero: State) {
            health = 100 + Double(hero.upgrades["health"] ?? 0) * 15
            attack = 15 + Double(hero.upgrades["attack"] ?? 0) * 3
            movement = 120 + Double(hero.upgrades["movement"] ?? 0) * 6
        }
    }
    public static let odds = [60, 25, 10, 4, 1]
    public static func draw(roll: Double, pick: Double, odds: [Int] = RPG.odds) throws -> Item {
        guard roll.isFinite, pick.isFinite, (0..<1).contains(roll), (0..<1).contains(pick), odds.count == 5,
            odds.allSatisfy({ (0...100).contains($0) }), odds.reduce(0, +) == 100
        else { throw Failure.invalidReward }
        var boundary = 0.0
        for (index, weight) in odds.enumerated() {
            boundary += Double(weight)
            if roll * 100 < boundary {
                let items = catalog.filter { $0.rarity == Rarity.allCases[index] }
                guard !items.isEmpty else { throw Failure.invalidReward }
                return items[Int(pick * Double(items.count))]
            }
        }
        throw Failure.invalidReward
    }
    public static func randomItem() throws -> Item {
        try draw(
            roll: Double(UInt32.random(in: .min ... .max)) / 4_294_967_296,
            pick: Double(UInt32.random(in: .min ... .max)) / 4_294_967_296)
    }
    public struct Milestone: Sendable {
        public let achievement: Achievement
        public let done: Int
        public let target: Int
    }
    public static func milestones(_ hero: State) -> [Milestone] {
        [
            Milestone(achievement: .rpgWorker, done: hero.receipts.filter { !$0.kind.combat }.count, target: 10),
            Milestone(achievement: .rpgVeteran, done: hero.xp, target: 1000),
            Milestone(achievement: .rpgBoss, done: hero.receipts.filter { $0.kind == .boss && $0.xp > 0 }.count, target: 1),
        ]
    }
}
extension RPG.State {
    public mutating func grantBooster(_ id: String) throws {
        guard !id.isEmpty, id.count <= 200 else { throw RPG.Failure.invalidReward }
        if boosters.contains(id) || openings[id] != nil { return }
        guard boosters.count + openings.count < RPG.receiptLimit else { throw RPG.Failure.receiptLimit }
        boosters.append(id)
    }
    public mutating func claimMilestones() throws {
        for milestone in RPG.milestones(self) where milestone.done >= milestone.target {
            try grantBooster("achievement-v1-\(milestone.achievement.rawValue)")
        }
    }
}
