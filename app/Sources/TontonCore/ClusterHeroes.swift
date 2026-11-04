import Foundation

/// The cluster's XP leaderboard (docs/cluster.md, The leaderboard): one sealed document, `leaderboard`, where each member
/// who chose to share its Tonton keeps one entry: its level, what it wears, its XP today and since the cluster's clock
/// started (or since it joined), and its last level-ups, which the feed shows. Never the inventory, the receipts or what
/// the work was. Each member's own clients write its entry and leave the others as they found them. Mirrors
/// shared/cluster-heroes.ts; shared/test/cluster-heroes-vectors.json holds what both must agree on.
public enum ClusterHeroes {
    public static let document = "leaderboard"
    /// Level-ups kept per member, newest last: enough for the feed between two visits.
    public static let levelUps = 10
    /// More entries than a cluster can have members, so an older relay's larger cap never hides one.
    static let maxHeroes = 100

    /// Where a member's count starts: the clock's start when the cluster has one, else when the member joined.
    public static func from(clockStartedAt: String?, joinedAt: String) -> String {
        if let clockStartedAt, date(clockStartedAt) != nil { return clockStartedAt }
        return joinedAt
    }

    /// The members' level-ups for the feed, newest first: "Alice's Tonton reached level 12". Members only.
    public static func levelUps(_ board: ClusterLeaderboard?, members: [String]) -> [ClusterLevelUpLine] {
        let current = Set(members)
        return (board?.heroes ?? []).filter { current.contains($0.account) }
            .flatMap { hero in hero.levelUps.map { ClusterLevelUpLine(account: hero.account, level: $0.level, at: $0.at) } }
            .sorted { a, b in
                let (left, right) = (date(a.at) ?? .distantPast, date(b.at) ?? .distantPast)
                return left != right ? left > right : a.level > b.level
            }
    }

    static func date(_ text: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    /// As JavaScript's `toISOString`, milliseconds included, so both sides write the same text.
    static func text(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}

public struct ClusterLevelUp: Codable, Equatable, Sendable {
    public var level: Int
    /// When the member's client saw it.
    public var at: String

    public init(level: Int, at: String) { (self.level, self.at) = (level, at) }

    init?(json: ClusterJSON) {
        guard let level = json["level"]?.count, (1...100).contains(level), let at = json["at"]?.date else { return nil }
        self.init(level: level, at: at)
    }
}

public struct ClusterLevelUpLine: Equatable, Sendable {
    public let account: String
    public let level: Int
    public let at: String
}

public struct ClusterHero: Codable, Equatable, Sendable {
    public var account: String
    public var level: Int
    /// XP of `day`, the UTC day it was counted on: another day reads as none.
    public var today: Int
    public var day: String
    /// XP since `from`, the clock's start or when the member joined.
    public var since: Int
    public var from: String
    /// The member's XP when `from` came: `since` stays right once old receipts are pruned.
    public var base: Int
    public var equipped: [String: String]
    public var levelUps: [ClusterLevelUp]
    public var updatedAt: String

    init?(json: ClusterJSON) {
        guard let account = json["account"]?.string, !account.isEmpty, account.count <= 200,
            let level = json["level"]?.count, (1...100).contains(level), let today = json["today"]?.count,
            let since = json["since"]?.count, let base = json["base"]?.count,
            let day = json["day"]?.string, day.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil,
            let from = json["from"]?.date, let updatedAt = json["updatedAt"]?.date
        else { return nil }
        var equipped: [String: String] = [:]
        for slot in RPG.Slot.allCases {
            if let id = json["equipped"]?[slot.rawValue]?.string, id.count <= 200 { equipped[slot.rawValue] = id }
        }
        let levelUps = (json["levelUps"]?.array ?? []).compactMap(ClusterLevelUp.init(json:)).suffix(ClusterHeroes.levelUps)
        (self.account, self.level, self.today, self.day, self.since) = (account, level, today, day, since)
        (self.from, self.base, self.equipped, self.levelUps, self.updatedAt) = (from, base, equipped, Array(levelUps), updatedAt)
    }

    /// This member's entry, from its hero. `previous` is its entry as the document has it: the base carries over while
    /// `from` stays, and a level above the previous one is a level-up. Another of the member's clients may read an older
    /// hero: for the same start, the level, the XP since and of the day never go down, and a level is a level-up once.
    public init(hero: RPG.State, account: String, from: String, previous: ClusterHero?, now: Date = Date()) {
        let start = ClusterHeroes.date(from) ?? now
        let earned = (hero.receipts + hero.gains).filter { Self.earned($0, since: start) }.reduce(0) { $0 + $1.xp }
        let same = previous?.from == from
        let base = same ? previous?.base ?? 0 : max(0, hero.xp - earned)
        let level = max(previous?.level ?? 1, RPG.level(hero.xp))
        let at = ClusterHeroes.text(now)
        var levelUps = previous?.levelUps ?? []
        if let previous, level > previous.level, !levelUps.contains(where: { $0.level == level }) {
            levelUps.append(ClusterLevelUp(level: level, at: at))
        }
        let today = hero.today(now: now)
        let todayXP = previous?.day == today.day ? max(previous?.today ?? 0, today.xp) : today.xp
        let since = max(same ? previous?.since ?? 0 : 0, hero.xp - base, 0)
        var equipped: [String: String] = [:]
        for slot in RPG.Slot.allCases {
            if let id = hero.equipped[slot.rawValue], hero.owned.contains(id) { equipped[slot.rawValue] = id }
        }
        (self.account, self.level, self.today, self.day, self.since) = (account, level, todayXP, today.day, since)
        (self.from, self.base, self.equipped) = (from, base, equipped)
        (self.levelUps, self.updatedAt) = (Array(levelUps.suffix(ClusterHeroes.levelUps)), at)
    }

    /// Older receipts only know their day: they count from the day after `from`'s.
    private static func earned(_ receipt: RPG.Receipt, since start: Date) -> Bool {
        if let at = receipt.at { return (ClusterHeroes.date(at) ?? .distantPast) >= start }
        guard let day = ClusterHeroes.date(receipt.day + "T00:00:00Z"), let first = ClusterHeroes.date(RPG.day(start) + "T00:00:00Z") else {
            return false
        }
        return day >= first.addingTimeInterval(86_400)
    }

    /// Whether two entries say the same, the time they were written aside: an unchanged entry is not written again.
    public func same(as other: ClusterHero) -> Bool {
        var other = other
        other.updatedAt = updatedAt
        return self == other
    }
}

/// One line of the board: a member, with its numbers if it shares them.
public struct ClusterRank: Equatable, Sendable {
    public let account: String
    /// 1 for the first; nil for a member who does not share.
    public let rank: Int?
    public let hero: ClusterHero?
    /// Its XP since the current start: 0 while its entry still counts from an earlier clock.
    public let since: Int
    /// Its XP of the current UTC day, 0 when its entry is from an earlier one.
    public let today: Int
}

public struct ClusterLeaderboard: Equatable, Sendable, ClusterPayload {
    public private(set) var heroes: [ClusterHero]
    /// Every entry as it was sealed, those this client cannot read and fields it does not know included: a write puts them
    /// back as they were, so an older client never strips what a newer one wrote.
    var entries: [ClusterJSON]

    public init() { (heroes, entries) = ([], []) }

    /// Entries that don't read are left out of `heroes`, and one per member.
    init?(json: ClusterJSON) {
        guard let items = json["heroes"]?.array else { return nil }
        entries = Array(items.prefix(ClusterHeroes.maxHeroes))
        var seen = Set<String>()
        heroes = entries.compactMap(ClusterHero.init(json:)).filter { seen.insert($0.account).inserted }
    }

    /// What is sealed: every entry as it was found, and this member's own as it now is.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        try container.encode(entries, forKey: .heroes)
    }

    private enum Keys: String, CodingKey { case heroes }

    /// The document with this member's entry put in, replaced, or taken out (nil). Every other entry stays as it was.
    public func with(_ entry: ClusterHero?, for account: String) -> ClusterLeaderboard {
        var board = self
        board.heroes = heroes.filter { $0.account != account }
        board.entries = entries.filter { $0["account"]?.string != account }
        if let entry, let json = try? JSONDecoder().decode(ClusterJSON.self, from: JSONEncoder().encode(entry)) {
            board.heroes.append(entry)
            board.entries.append(json)
        }
        return board
    }

    /// Every member, ranked: those who share by XP since the start, then level, then account id in code-unit order, as
    /// the pools' boards; then those who don't, without numbers, in the order given. An entry that still counts from an
    /// earlier clock, whose member's clients were closed since, counts as no XP since this one started.
    public func ranked(_ members: [(account: String, joinedAt: String)], clockStartedAt: String?, now: Date = Date()) -> [ClusterRank] {
        let day = RPG.day(now)
        let byAccount = Dictionary(heroes.map { ($0.account, $0) }, uniquingKeysWith: { first, _ in first })
        let sharing = members.compactMap { member -> (hero: ClusterHero, since: Int)? in
            guard let hero = byAccount[member.account] else { return nil }
            let current = hero.from == ClusterHeroes.from(clockStartedAt: clockStartedAt, joinedAt: member.joinedAt)
            return (hero, current ? hero.since : 0)
        }
        .sorted { a, b in
            if a.since != b.since { return a.since > b.since }
            if a.hero.level != b.hero.level { return a.hero.level > b.hero.level }
            return Array(a.hero.account.utf16).lexicographicallyPrecedes(b.hero.account.utf16)
        }
        let ranked = sharing.enumerated().map { index, item in
            ClusterRank(
                account: item.hero.account, rank: index + 1, hero: item.hero, since: item.since,
                today: item.hero.day == day ? item.hero.today : 0)
        }
        let quiet = members.filter { byAccount[$0.account] == nil }
        return ranked + quiet.map { ClusterRank(account: $0.account, rank: nil, hero: nil, since: 0, today: 0) }
    }
}

extension ClusterJSON: Encodable {
    /// Written back as it was read, for what a client keeps without understanding it.
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

extension ClusterVault {
    public func leaderboard(_ state: ClusterState) -> ClusterLeaderboard? {
        read(state.docs.first { $0.name == ClusterHeroes.document }?.blob, as: ClusterLeaderboard.self)
    }
}
