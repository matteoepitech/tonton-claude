import Foundation
import XCTest

@testable import TontonCore

/// Rules version 2: shared/test/rpg-v2-vectors.json, as shared/test/rpg-v2.test.ts checks it, and version 1 compatibility.
final class RPGRulesTests: XCTestCase {
    struct Vectors: Decodable { let cases: [Case] }
    struct Case: Decodable {
        let name: String
        let now: String
        let start: RPG.State?
        let rewards: [Step]
        let expect: Expect
    }
    struct Step: Decodable {
        let kind: RPG.Kind
        let source: String
        let at: String
        let seconds: Int?
        let prompted: Bool?
        let note: String?
        let times: Int?
    }
    struct Expect: Decodable {
        let xp: Int
        let sparks: Int
        let level: Int
        let boosters: [String]
        let owned: [String]
        let receipts: Int
        let gains: Int
        let today: [Today]
        let journal: [Journal]?
    }
    struct Today: Decodable {
        let now: String
        let day: String
        let xp: Int
        let streak: Int
        let hours: [String: Int]
    }
    struct Journal: Decodable {
        let id: String
        let kind: RPG.Kind
        let xp: Int
        let sparks: Int
        let day: String
        let at: String?
        let seconds: Int?
        let note: String?
    }

    static let shared = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("shared/test")

    func date(_ iso: String) throws -> Date { try XCTUnwrap(ISO8601DateFormatter().date(from: iso)) }

    func testSharedFixtures() throws {
        let vectors = try JSONDecoder().decode(
            Vectors.self, from: Data(contentsOf: Self.shared.appendingPathComponent("rpg-v2-vectors.json")))
        XCTAssertEqual(vectors.cases.count, 7)
        for c in vectors.cases {
            var hero = c.start ?? RPG.State()
            let now = try date(c.now)
            for step in c.rewards {
                for i in 0..<(step.times ?? 1) {
                    let source = step.times == nil ? step.source : "\(step.source)\(i)"
                    try hero.award(
                        RPG.Reward(
                            kind: step.kind, source: source, at: step.at, seconds: step.seconds, prompted: step.prompted, note: step.note),
                        now: now)
                    try hero.validate()
                }
            }
            let e = c.expect
            XCTAssertEqual([hero.xp, hero.sparks, hero.level], [e.xp, e.sparks, e.level], c.name)
            XCTAssertEqual(hero.boosters, e.boosters, c.name)
            XCTAssertEqual(hero.owned, e.owned, c.name)
            XCTAssertEqual([hero.receipts.count, hero.gains.count], [e.receipts, e.gains], c.name)
            for t in e.today {
                let today = hero.today(now: try date(t.now))
                let hours = (0..<24).map { t.hours[String($0)] ?? 0 }
                XCTAssertEqual(today, RPG.Today(day: t.day, xp: t.xp, streak: t.streak, hours: hours), "\(c.name) at \(t.now)")
            }
            if let journal = e.journal {
                let expected = journal.map {
                    RPG.JournalEntry(
                        id: $0.id, kind: $0.kind, xp: $0.xp, sparks: $0.sparks, day: $0.day, at: $0.at, seconds: $0.seconds, note: $0.note)
                }
                XCTAssertEqual(hero.journal(limit: journal.count), expected, c.name)
            }
        }
    }

    func testCalendarDays() throws {
        XCTAssertEqual(RPG.shift("2028-02-28", by: 1), "2028-02-29")
        XCTAssertEqual(RPG.shift("2026-03-01", by: -1), "2026-02-28")
        XCTAssertEqual(RPG.shift("2026-12-31", by: 1), "2027-01-01")
        XCTAssertEqual(RPG.shift("2026-11-30", by: -30), "2026-10-31")
        XCTAssertEqual(RPG.day(Date(timeIntervalSince1970: 0)), "1970-01-01")
        XCTAssertEqual(RPG.day(try date("2026-11-04T23:59:59Z")), "2026-11-04")
        XCTAssertNil(RPG.days("2026-02-30"))
        XCTAssertNil(RPG.days("2026-1-04"))
        XCTAssertEqual(RPG.days("2026-11-04"), 20_761)
    }

    func testRewardDetails() throws {
        XCTAssertNil(RPG.Reward(kind: .task, source: "x", at: "2026-11-04").at)
        XCTAssertNil(RPG.Reward(kind: .task, source: "x", at: "2026-11-04T10:00:00+01:00").at)
        XCTAssertEqual(RPG.Reward(kind: .turn, source: "x", at: "2026-11-04T10:00:00.123Z").at, "2026-11-04T10:00:00.123Z")
        XCTAssertEqual(RPG.Reward(kind: .turn, source: "x", at: "2026-11-04T10:00:00Z", seconds: -3).seconds, 0)
        XCTAssertEqual(RPG.Reward(kind: .turn, source: "x", at: "2026-11-04T10:00:00Z", seconds: 90_000).seconds, 86_400)
        let note = RPG.Reward(kind: .push, source: "x", at: "2026-11-04T10:00:00Z", note: "  \(String(repeating: "a", count: 79))🎮b ").note
        XCTAssertEqual(note, String(repeating: "a", count: 79))
        XCTAssertNil(RPG.Reward(kind: .push, source: "x", at: "2026-11-04T10:00:00Z", note: "   ").note)
        let a = RPG.Reward(kind: .turn, source: "s\nt", at: "2026-11-04T10:00:00Z", seconds: 60, prompted: true)
        let b = RPG.Reward(kind: .turn, source: "s\nt", at: "2026-11-04T11:00:00Z", seconds: 600, prompted: true)
        XCTAssertEqual(a.id, b.id)
        var hero = RPG.State()
        try hero.award(a, now: try date("2026-11-04T12:00:00Z"))
        let once = hero
        try hero.award(b, now: try date("2026-11-04T12:00:00Z"))
        XCTAssertEqual(hero, once)
        XCTAssertEqual(hero.gains.count, 1)
        hero.receipts = hero.gains
        XCTAssertThrowsError(try hero.validate())
    }

    /// The fields an app of rules version 1 decodes. A frozen copy of what is installed: never update it.
    struct ReleasedState: Codable {
        enum Kind: String, Codable { case task, poolTask, review, encounter, boss }
        struct Receipt: Codable {
            let id: String
            let kind: Kind
            let day: String
            let xp: Int
            let sparks: Int
        }
        struct Opening: Codable {
            let item: String
            let duplicateSparks: Int
            var tableVersion: Int? = 1
        }
        var version: Int
        var xp: Int
        var sparks: Int
        var receipts: [Receipt]
        var owned: [String]
        var equipped: [String: String]
        var boosters: [String]
        var openings: [String: Opening]
        var upgrades: [String: Int]
    }

    func testReleasedAppsOpenAVersion2Hero() throws {
        let now = try date("2026-11-04T18:00:00Z")
        var hero = RPG.State()
        for i in 0..<4 {
            try hero.award(RPG.Reward(kind: .turn, source: "s\n\(i)", at: "2026-11-04T10:00:00Z", seconds: 3600, prompted: true), now: now)
        }
        try hero.award(RPG.Reward(kind: .task, source: "s\nWrite it", at: "2026-11-04T10:30:00Z"), now: now)
        try hero.award(RPG.Reward(kind: .day, source: "2026-11-04", at: "2026-11-04T10:00:00Z"), now: now)
        let data = try JSONEncoder().encode(hero)
        let released = try JSONDecoder().decode(ReleasedState.self, from: data)
        XCTAssertEqual([released.xp, RPG.level(released.xp), released.sparks], [hero.xp, hero.level, hero.sparks])
        XCTAssertEqual(released.boosters, hero.boosters)
        XCTAssertEqual(released.owned, hero.owned)
        XCTAssertEqual(released.receipts.map(\.id), hero.receipts.map(\.id))
        // A released app that writes the hero back keeps every balance but drops the gains (docs/rpg.md, Rollout).
        let rewritten = try JSONDecoder().decode(RPG.State.self, from: JSONEncoder().encode(released))
        XCTAssertEqual([rewritten.xp, rewritten.sparks], [hero.xp, hero.sparks])
        XCTAssertTrue(rewritten.gains.isEmpty)
        try rewritten.validate()
    }

    func testAVersion1HeroOpensAndEncodesAsBefore() throws {
        struct Fixture: Decodable { var state: RPG.State }
        let url = Self.shared.appendingPathComponent("rpg-vectors.json")
        let v1 = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url)).state
        try v1.validate()
        XCTAssertTrue(v1.gains.isEmpty)
        let json = try XCTUnwrap(String(data: JSONEncoder().encode(v1), encoding: .utf8))
        XCTAssertFalse(json.contains("gains"))
        XCTAssertFalse(json.contains("\"at\""))
    }
}
