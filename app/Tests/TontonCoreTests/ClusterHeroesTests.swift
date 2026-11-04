import XCTest

@testable import TontonCore

/// shared/test/cluster-heroes-vectors.json, also checked by shared/test/cluster-heroes.test.ts: both sides write the same
/// entries and rank the same way.
final class ClusterHeroesTests: XCTestCase {
    private struct Vectors: Decodable {
        struct Entry: Decodable {
            let name: String
            let hero: RPG.State
            let account: String
            let from: String
            let previous: ClusterHero?
            let now: String
            let expected: ClusterHero
        }
        struct Rank: Decodable {
            let account: String
            let rank: Int?
            let since: Int
            let today: Int
        }
        struct Ranking: Decodable {
            let members: [Member]
            let clockStartedAt: String
            let now: String
            let decodedAccounts: [String]
            let expected: [Rank]
            let levelUps: [Line]
        }
        struct Member: Decodable {
            let account: String
            let joinedAt: String
        }
        struct Line: Decodable {
            let account: String
            let level: Int
            let at: String
        }
        let entries: [Entry]
        let ranking: Ranking
    }

    private let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent(
        "../../../shared/test/cluster-heroes-vectors.json")

    func testEachEntryAsTheWebsiteWorksItOut() throws {
        let vectors = try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
        XCTAssertEqual(vectors.entries.count, 4)
        for item in vectors.entries {
            let now = try XCTUnwrap(ClusterHeroes.date(item.now))
            let entry = ClusterHero(hero: item.hero, account: item.account, from: item.from, previous: item.previous, now: now)
            XCTAssertEqual(entry, item.expected, item.name)
        }
    }

    func testTheRankingAndTheFeedsLevelUps() throws {
        let data = try Data(contentsOf: url)
        let vectors = try JSONDecoder().decode(Vectors.self, from: data)
        let json = try JSONDecoder().decode(ClusterJSON.self, from: data)
        let board = try XCTUnwrap(json["ranking"]?["board"].flatMap(ClusterLeaderboard.init(json:)))
        XCTAssertEqual(board.heroes.map(\.account), vectors.ranking.decodedAccounts)
        let members = vectors.ranking.members.map(\.account)
        let ranks = board.ranked(
            vectors.ranking.members.map { ($0.account, $0.joinedAt) }, clockStartedAt: vectors.ranking.clockStartedAt,
            now: try XCTUnwrap(ClusterHeroes.date(vectors.ranking.now)))
        XCTAssertEqual(ranks.map(\.account), vectors.ranking.expected.map(\.account))
        XCTAssertEqual(ranks.map(\.rank), vectors.ranking.expected.map(\.rank))
        XCTAssertEqual(ranks.map(\.since), vectors.ranking.expected.map(\.since))
        XCTAssertEqual(ranks.map(\.today), vectors.ranking.expected.map(\.today))
        // A member who does not share has no numbers.
        XCTAssertNil(ranks.first { $0.account == "acc-carol" }?.hero)
        let ups = ClusterHeroes.levelUps(board, members: members)
        XCTAssertEqual(ups.map(\.account), vectors.ranking.levelUps.map(\.account))
        XCTAssertEqual(ups.map(\.level), vectors.ranking.levelUps.map(\.level))
        XCTAssertEqual(ups.map(\.at), vectors.ranking.levelUps.map(\.at))
    }

    func testAMemberChangesOnlyItsOwnEntry() throws {
        let data = try Data(contentsOf: url)
        let json = try JSONDecoder().decode(ClusterJSON.self, from: data)
        let board = try XCTUnwrap(json["ranking"]?["board"].flatMap(ClusterLeaderboard.init(json:)))
        var bob = try XCTUnwrap(board.heroes.first { $0.account == "acc-bob" })
        bob.since = 999
        let changed = board.with(bob, for: "acc-bob")
        XCTAssertEqual(changed.heroes.filter { $0.account != "acc-bob" }, board.heroes.filter { $0.account != "acc-bob" })
        XCTAssertEqual(changed.heroes.first { $0.account == "acc-bob" }?.since, 999)
        XCTAssertFalse(board.with(nil, for: "acc-bob").heroes.contains { $0.account == "acc-bob" })
        // What this client cannot read is written back as it was: the broken entry and the later duplicate stay sealed.
        let sealed = try JSONDecoder().decode(ClusterJSON.self, from: JSONEncoder().encode(changed))
        XCTAssertEqual(sealed["heroes"]?.array?.count, board.entries.count)
        XCTAssertTrue(sealed["heroes"]?.array?.contains { $0["account"]?.string == "acc-bad" } == true)
        // Written again only when something but the time changed.
        var later = bob
        later.updatedAt = "2026-11-05T00:00:00.000Z"
        XCTAssertTrue(bob.same(as: later))
        later.level += 1
        XCTAssertFalse(bob.same(as: later))
    }

    func testTheCountStartsAtTheClockElseAtJoining() {
        XCTAssertEqual(ClusterHeroes.from(clockStartedAt: "2026-11-04T09:00:00Z", joinedAt: "2026-10-01T00:00:00Z"), "2026-11-04T09:00:00Z")
        XCTAssertEqual(ClusterHeroes.from(clockStartedAt: nil, joinedAt: "2026-10-01T00:00:00Z"), "2026-10-01T00:00:00Z")
        XCTAssertEqual(ClusterHeroes.from(clockStartedAt: "soon", joinedAt: "2026-10-01T00:00:00Z"), "2026-10-01T00:00:00Z")
    }
}
