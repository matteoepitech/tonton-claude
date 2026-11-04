import Foundation
import XCTest

@testable import TontonCore

/// The leaderboard as the notch follows it (ClusterBoardHeroes.swift): what sharing writes, what it leaves alone, and a
/// board it refuses to write over.
final class ClusterBoardHeroesTests: XCTestCase {
    private let account = Account(relay: "https://relay.example.com", accountId: "acct00000001", token: "ta_x", key: E2E.newKey())
    private var vault: SessionVault { SessionVault(key: (try? account.symmetricKey()) ?? .init(size: .bits256)) }
    private let key = E2E.newKey()
    private let joinedAt = "2026-11-01T00:00:00Z"
    private let now = ISO8601DateFormatter().date(from: "2026-11-04T12:00:00Z") ?? Date()

    private func member(_ id: String) -> [String: Any] {
        ["account": id, "role": "member", "joinedAt": joinedAt, "profile": NSNull(), "publicKeys": []]
    }

    /// A board of two members, with the leaderboard document given, sealed as it is.
    private func board(leaderboard blob: String? = nil, rev: Int = 3) throws -> ClusterBoard {
        let grant: [String: Any] = [
            "id": "clus00000001", "role": "member", "createdAt": "2026-11-01T00:00:00.000Z", "keyVersion": 1,
            "info": try ClusterVault(key: key).seal(ClusterInfo(name: "Jam")),
            "key": try vault.sealClusterKeyGrant(clusterId: "clus00000001", key: key, version: 1), "members": 2, "secret": NSNull(),
            "wraps": [],
        ]
        let summary = try JSONDecoder().decode(ClusterSummary.self, from: try JSONSerialization.data(withJSONObject: grant))
        var board = try XCTUnwrap(ClusterBoard(summary: summary, vault: vault))
        var docs: [[String: Any]] = []
        if let blob {
            docs.append([
                "name": ClusterHeroes.document, "rev": rev, "updatedAt": "t", "account": "acct00000002", "session": NSNull(), "blob": blob,
            ])
        }
        let snapshot: [String: Any] = [
            "t": "cluster_snapshot",
            "cluster": [
                "id": "clus00000001", "createdAt": "t", "keyVersion": 1, "info": grant["info"] ?? "",
                "members": [member("acct00000001"), member("acct00000002")], "sessions": [], "posts": [], "docs": docs,
            ],
        ]
        let update = try JSONDecoder().decode(ClusterUpdate.self, from: try JSONSerialization.data(withJSONObject: snapshot))
        XCTAssertTrue(board.take(update, account: "acct00000001", vault: vault))
        return board
    }

    private var hero: RPG.State {
        var hero = RPG.State()
        hero.xp = 400
        hero.gains = [
            RPG.Receipt(
                id: String(repeating: "a", count: 64), kind: .turn, day: "2026-11-04", xp: 30, sparks: 3, at: "2026-11-04T10:00:00Z")
        ]
        hero.owned = ["hat-rare"]
        hero.equipped = ["hat": "hat-rare"]
        return hero
    }

    func testSharingPutsInOnlyThisMembersEntry() throws {
        let board = try board()
        XCTAssertEqual(board.ranks(now: now).map(\.rank), [nil, nil], "nobody shares yet: both without numbers")
        guard case .write(let rev, let next) = board.share(hero, account: "acct00000001", now: now) else {
            return XCTFail("a first entry is written")
        }
        XCTAssertEqual(rev, 0)
        XCTAssertEqual(next.heroes.map(\.account), ["acct00000001"])
        XCTAssertEqual(next.heroes.first?.since, 30)
        XCTAssertEqual(next.heroes.first?.equipped, ["hat": "hat-rare"])
        XCTAssertEqual(board.share(nil, account: "acct00000001", now: now), .unchanged, "nothing to take off")
        XCTAssertEqual(board.share(hero, account: "acct00000009", now: now), .notOpen, "not a member")
    }

    func testTheOthersEntriesGoBackAsTheyWereAndAnUnchangedEntryIsNotWritten() throws {
        let cluster = try ClusterVault(key: key)
        let mine = ClusterHero(hero: hero, account: "acct00000001", from: joinedAt, previous: nil, now: now)
        let other: [String: Any] = [
            "account": "acct00000002", "level": 6, "today": 0, "day": "2026-11-04", "since": 900, "from": joinedAt, "base": 10,
            "equipped": [:] as [String: String], "levelUps": [] as [Any], "updatedAt": "2026-11-04T09:00:00Z", "mood": "happy",
        ]
        let mineJSON = try JSONSerialization.jsonObject(with: JSONEncoder().encode(mine))
        let sealed = try cluster.keyring.seal(AnyJSON(["heroes": [other, mineJSON]]))
        let board = try board(leaderboard: sealed)
        XCTAssertTrue(board.sharesHero(account: "acct00000001"))
        XCTAssertEqual(board.share(hero, account: "acct00000001", now: now.addingTimeInterval(60)), .unchanged)
        XCTAssertEqual(board.ranks(now: now).map(\.account), ["acct00000002", "acct00000001"])
        guard case .write(let rev, let next) = board.share(nil, account: "acct00000001", now: now) else {
            return XCTFail("taking it off is written")
        }
        XCTAssertEqual(rev, 3, "over the revision this member saw")
        let written = try JSONDecoder().decode(ClusterJSON.self, from: JSONEncoder().encode(next))
        XCTAssertEqual(written["heroes"]?.array?.count, 1)
        XCTAssertEqual(written["heroes"]?.array?.first?["mood"]?.string, "happy", "a field this client does not know stays")
    }

    func testABoardThatDoesNotOpenIsNeverWrittenOver() throws {
        let stranger = try ClusterVault(key: E2E.newKey()).seal(ClusterInfo(name: "not a board"))
        let board = try board(leaderboard: stranger)
        XCTAssertNil(board.leaderboard)
        XCTAssertEqual(board.share(hero, account: "acct00000001", now: now), .unreadable)
    }

    func testACrossedWriteOnTheLeaderboardSaysNothing() throws {
        var board = try board()
        let cluster = try ClusterVault(key: key)
        let conflict: [String: Any] = [
            "t": "cluster_conflict", "clusterId": "clus00000001", "name": ClusterHeroes.document,
            "current": [
                "name": ClusterHeroes.document, "rev": 4, "updatedAt": "t2", "account": "acct00000002", "session": NSNull(),
                "blob": try cluster.seal(ClusterLeaderboard()),
            ],
        ]
        let update = try JSONDecoder().decode(ClusterUpdate.self, from: try JSONSerialization.data(withJSONObject: conflict))
        XCTAssertTrue(board.take(update, account: "acct00000001", vault: vault))
        XCTAssertNil(board.problem, "the store writes its entry again over the newer board")
        XCTAssertEqual(board.leaderboardRev, 4)
    }
}

/// Any JSON object, sealed as it is.
private struct AnyJSON: Encodable {
    let value: Any
    init(_ value: Any) { self.value = value }
    func encode(to encoder: Encoder) throws {
        let data = try JSONSerialization.data(withJSONObject: value)
        try JSONDecoder().decode(ClusterJSON.self, from: data).encode(to: encoder)
    }
}
