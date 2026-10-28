import Foundation

/// Only explicitly shared appearance and pool contributions. Mirrors shared/rpg-pool.ts.
public struct RPGPoolLedger: Codable, Equatable, Sendable {
    public struct Profile: Codable, Equatable, Sendable {
        public var name: String
        public var level: Int
        public var equipped: [String: String]
        public var hero: RPG.State {
            var state = RPG.State()
            state.xp = RPG.threshold(level)
            state.equipped = equipped
            state.owned = Array(equipped.values)
            return state
        }
    }
    public struct Goal: Codable, Equatable, Sendable { public var eligible: [String]; public var at: String }
    public var version = 1
    public var completions: [String: PoolCompletion] = [:]
    public var profiles: [String: Profile] = [:]
    public var goals: [String: Goal] = [:]
    public init() {}
    public static func timestamp(_ value: String) -> TimeInterval {
        (ISO8601DateFormatter().date(from: value) ?? ISO8601DateFormatter.rpgFractional.date(from: value))?.timeIntervalSince1970 ?? 0
    }
    public func completedCount(since: String) -> Int { completions.values.filter { Self.timestamp($0.at) >= Self.timestamp(since) }.count }
    public static let targets = [3, 10, 25]
    public static func runStart(_ state: PoolState) -> String { state.info?.startedAt ?? state.createdAt }
    public static func goalID(_ state: PoolState, target: Int) -> String { "team-v1-\(state.id)-\(runStart(state))-\(target)" }
    public func validate() throws {
        let date: (String) -> Bool = {
            ISO8601DateFormatter().date(from: $0) != nil || ISO8601DateFormatter.rpgFractional.date(from: $0) != nil
        }
        let ref: (PoolSessionRef) -> Bool = {
            !$0.account.isEmpty && $0.account.count <= 200 && !$0.session.isEmpty && $0.session.count <= 200
        }
        guard version == 1, completions.count <= 10_000, profiles.count <= 1000, goals.count <= 1000,
            completions.allSatisfy({
                !$0.key.isEmpty && !$0.key.isEmpty && $0.key.count <= 200 && date($0.value.at) && ref($0.value.assignee)
                    && ($0.value.reviewer.map(ref) ?? true)
            }),
            profiles.allSatisfy({
                !$0.key.isEmpty && $0.key.count <= 200 && $0.value.name.count <= 200 && (1...100).contains($0.value.level)
                    && $0.value.equipped.count <= 5
                    && $0.value.equipped.allSatisfy { slot, id in RPG.catalog.contains { $0.slot.rawValue == slot && $0.id == id } }
            }),
            goals.allSatisfy({
                !$0.key.isEmpty && $0.key.count <= 200 && date($0.value.at) && $0.value.eligible.count <= 1000
                    && $0.value.eligible.allSatisfy { !$0.isEmpty && $0.count <= 200 }
            })
        else { throw RPG.Failure.invalidState }
    }
    public mutating func sync(_ state: PoolState, account: String, hero: RPG.State) throws {
        for item in state.tasks where completions[item.id] == nil {
            if let completion = item.task?.completion { completions[item.id] = completion }
        }
        var equipped: [String: String] = [:]
        for slot in RPG.Slot.allCases { if let item = hero.item(slot) { equipped[slot.rawValue] = item.id } }
        profiles[account] = Profile(
            name: String((state.members.first { $0.account == account }?.profile?.name ?? account).prefix(200)),
            level: hero.level, equipped: equipped)
        let rows = completions.filter { Self.timestamp($0.value.at) >= Self.timestamp(Self.runStart(state)) }.sorted {
            Self.timestamp($0.value.at) == Self.timestamp($1.value.at)
                ? $0.key < $1.key : Self.timestamp($0.value.at) < Self.timestamp($1.value.at)
        }
        for target in Self.targets where rows.count >= target {
            let id = Self.goalID(state, target: target)
            if goals[id] != nil { continue }
            let first = rows.prefix(target).map(\.value)
            goals[id] = Goal(
                eligible: Array(Set(first.flatMap { [$0.assignee.account] + ($0.reviewer.map { [$0.account] } ?? []) })).sorted(),
                at: first[target - 1].at)
        }
        try validate()
    }
    public func claim(_ hero: inout RPG.State, account: String) throws {
        for (id, goal) in goals where goal.eligible.contains(account) { try hero.grantBooster(id) }
    }
    public struct Standing: Identifiable, Sendable {
        public var id: String
        public var profile: Profile
        public var xp: Int
        public var departed: Bool
    }
    public func standings(_ state: PoolState, since: String) -> [Standing] {
        var rows: [String: Standing] = [:]
        let accounts = Set(
            state.members.map(\.account) + Array(profiles.keys)
                + completions.values.flatMap {
                    [$0.assignee.account] + ($0.reviewer.map { [$0.account] } ?? [])
                })
        for account in accounts {
            let member = state.members.first { $0.account == account }
            var profile = profiles[account] ?? Profile(name: account, level: 1, equipped: [:])
            if let name = member?.profile?.name { profile.name = name }
            rows[account] = Standing(id: account, profile: profile, xp: 0, departed: member == nil)
        }
        for c in completions.values where Self.timestamp(c.at) >= Self.timestamp(since) {
            rows[c.assignee.account]?.xp += 50
            if let reviewer = c.reviewer { rows[reviewer.account]?.xp += 20 }
        }
        return rows.values.sorted { $0.xp == $1.xp ? $0.id < $1.id : $0.xp > $1.xp }
    }
}
private extension ISO8601DateFormatter {
    static var rpgFractional: ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return formatter
    }
}

/// Pool keys stay on the client. Rotated keyrings can read the old ledger and seal its next revision with the new key.
public struct RPGPoolClient: Sendable {
    public let account: Account
    public let pool: String
    public let keys: PoolKeyring
    public init(account: Account, pool: String, keys: PoolKeyring) { self.account = account; self.pool = pool; self.keys = keys }
    private func request(_ method: String, body: Data? = nil) async throws -> (Data, Int) {
        guard let url = URL(string: account.relay + "/api/pools/\(pool)/rpg") else { throw RPG.Failure.invalidState }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        request.httpMethod = method; request.httpBody = body
        request.setValue("Bearer \(account.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) || (method == "PUT" && status == 409) else { throw RPG.Failure.invalidState }
        return (data, status)
    }
    public func read() async throws -> (Int, RPGPoolLedger) {
        let (data, _) = try await request("GET")
        let doc = try JSONDecoder().decode(RPGDocument.self, from: data)
        guard doc.rev >= 0, (doc.rev == 0) == (doc.blob == nil) else { throw RPG.Failure.invalidState }
        let ledger = try doc.blob.map { try keys.open($0, as: RPGPoolLedger.self) } ?? RPGPoolLedger()
        try ledger.validate()
        return (doc.rev, ledger)
    }
    public func sync(_ state: PoolState, hero: RPG.State) async throws -> RPGPoolLedger {
        for _ in 0..<8 {
            let (rev, previous) = try await read()
            var next = previous
            try next.sync(state, account: account.accountId, hero: hero)
            if next == previous { return next }
            let data = try JSONEncoder().encode(RPGDocument(rev: rev, blob: keys.seal(next)))
            if try await request("PUT", body: data).1 != 409 { return next }
        }
        throw RPG.Failure.conflict
    }
}
