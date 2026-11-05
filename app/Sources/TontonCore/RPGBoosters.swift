import Foundation

/// Boosters as the hero screen shows them: where each one comes from, as web/hero.ts says it, the order of past
/// openings, and Open all, which opens every booster in one save.
extension RPG {
    public enum BoosterSource: Equatable, Sendable {
        case level(Int)
        case boss
        case achievement
        case team
        case other

        /// From the booster's id: `level-N`, `boss-v1-…`, `achievement-v1-…`, `team-v1-…`.
        public init(_ id: String) {
            if id.hasPrefix("level-"), let level = Int(id.dropFirst(6)) {
                self = .level(level)
            } else if id.hasPrefix("boss-") {
                self = .boss
            } else if id.hasPrefix("achievement-") {
                self = .achievement
            } else if id.hasPrefix("team-") {
                self = .team
            } else {
                self = .other
            }
        }

        public var label: String {
            switch self {
            case .level(let level): String(core: "Level \(level)")
            case .boss: String(core: "Boss victory")
            case .achievement: String(core: "Achievement")
            case .team: String(core: "Team goal")
            case .other: String(core: "Booster")
            }
        }

        public var symbol: String {
            switch self {
            case .level: "arrow.up.circle.fill"
            case .boss: "crown.fill"
            case .achievement: "rosette"
            case .team: "person.3.fill"
            case .other: "shippingbox.fill"
            }
        }
    }

    /// Past openings, latest first as far as their ids tell: levels from the highest down, then the others by id.
    public static func openingOrder(_ ids: some Sequence<String>) -> [String] {
        ids.sorted { a, b in
            switch (BoosterSource(a), BoosterSource(b)) {
            case (.level(let x), .level(let y)): x > y
            case (.level, _): true
            case (_, .level): false
            default: a < b
            }
        }
    }

    /// One drop per booster, drawn before the save so that a retried save keeps the same drops.
    public static func draws(for boosters: [String]) throws -> [String: String] {
        try Dictionary(boosters.map { ($0, try randomItem().id) }, uniquingKeysWith: { first, _ in first })
    }
}

extension RPG.State {
    /// Opens each booster with its drop, in the order they were earned. One opened meanwhile, on another device, is no
    /// longer in `boosters` and keeps its first drop.
    public mutating func openBoosters(_ draws: [String: String]) throws {
        for booster in boosters {
            if let item = draws[booster] { try openBooster(booster, item: item) }
        }
    }
}

/// Boosters on show on the Boosters page: hidden for a moment the first time, then their drops.
public struct BoosterReveal: Equatable, Sendable {
    public let boosters: [String]
    public var uncovered: Bool

    public init(boosters: [String], uncovered: Bool) {
        self.boosters = boosters
        self.uncovered = uncovered
    }
}
