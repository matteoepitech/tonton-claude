import Foundation

// What the hero screen's Upgrades and Team pages show, apart from the views: each stat's rank, value and price, the
// achievement boosters Claim would grant, and where a period of the team's standings starts. Same numbers as
// RPG.Stats, State.upgrade and claimMilestones (shared/rpg.ts, shared/rpg-loot.ts).

extension RPG {
    /// The three stats sparks buy.
    public enum Stat: String, CaseIterable, Sendable {
        case health, attack, movement

        /// What one rank adds.
        public var step: Int {
            switch self {
            case .health: 15
            case .attack: 3
            case .movement: 6
            }
        }
    }

    public static let maxRank = 10

    /// A stat on the Upgrades page: its rank, its value, and the next rank's value and price, nil at the top.
    public struct Upgrade: Equatable, Sendable {
        public let stat: Stat
        public let rank: Int
        public let value: Int
        public let next: Int?
        public let price: Int?
        public let affordable: Bool

        public init(_ stat: Stat, of hero: State) {
            let stats = Stats(hero: hero)
            let value: Double =
                switch stat {
                case .health: stats.health
                case .attack: stats.attack
                case .movement: stats.movement
                }
            self.stat = stat
            rank = min(hero.upgrades[stat.rawValue] ?? 0, RPG.maxRank)
            self.value = Int(value)
            let top = rank >= RPG.maxRank
            next = top ? nil : Int(value) + stat.step
            price = top ? nil : (rank + 1) * 10
            affordable = price.map { hero.sparks >= $0 } ?? false
        }
    }
}

extension RPG.Milestone {
    /// The booster it grants once reached.
    public var booster: String { "achievement-v1-\(achievement.rawValue)" }
    public var reached: Bool { done >= target }
}

extension RPG.State {
    /// Milestones reached whose booster is neither waiting nor opened: what Claim achievement boosters grants.
    public var claimableMilestones: [RPG.Milestone] {
        RPG.milestones(self).filter { $0.reached && !boosters.contains($0.booster) && openings[$0.booster] == nil }
    }
}

extension RPGPoolLedger {
    /// The Team page's periods for the standings.
    public enum Period: String, CaseIterable, Sendable {
        case today, run, all
    }

    /// Where a period starts: midnight UTC, the run's start, or the beginning.
    public static func start(of period: Period, in state: PoolState, now: Date = Date()) -> String {
        switch period {
        case .all: ""
        case .run: runStart(state)
        case .today: String(ISO8601DateFormatter().string(from: now).prefix(10)) + "T00:00:00Z"
        }
    }
}
