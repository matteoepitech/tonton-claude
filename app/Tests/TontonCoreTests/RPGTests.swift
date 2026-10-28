import Foundation
import XCTest

@testable import TontonCore

final class RPGTests: XCTestCase {
    func testProgressionAndReplay() throws {
        var hero = RPG.State()
        for i in 0..<6 {
            let reward = RPG.Reward(kind: .poolTask, source: "pool/\(i)", at: "2026-10-28")
            try hero.award(reward)
            try hero.award(reward)
        }
        XCTAssertEqual(hero.xp, 300)
        XCTAssertEqual(hero.level, 3)
        XCTAssertEqual(hero.boosters, ["level-2", "level-3"])
        XCTAssertEqual(hero.owned, ["skin-common", "hat-common"])
        XCTAssertEqual(RPG.level(99), 1)
        XCTAssertEqual(RPG.level(100), 2)
        XCTAssertEqual(RPG.level(299), 2)
        XCTAssertEqual(RPG.level(9_007_199_254_740_991), 100)
    }

    func testWorkAndCombatCapsAndRetainedClaims() throws {
        var hero = RPG.State()
        for i in 0..<22 { try hero.award(RPG.Reward(kind: .poolTask, source: "\(i)", at: "2026-10-28")) }
        XCTAssertEqual(hero.xp, 1000)
        XCTAssertEqual(hero.receipts.count, 22)
        try hero.award(RPG.Reward(kind: .poolTask, source: "21", at: "2026-10-29"))
        XCTAssertEqual(hero.xp, 1000)
        for i in 0..<5 { try hero.award(RPG.Reward(kind: .boss, source: "\(i)", at: "2026-10-28")) }
        XCTAssertEqual(hero.xp, 1300)
        XCTAssertEqual(hero.sparks, 140)
    }

    func testInventorySlotsAndPixelBounds() throws {
        var hero = RPG.State()
        XCTAssertThrowsError(try hero.equip("hat-legendary", in: .hat))
        XCTAssertEqual(Set(RPG.catalog.map(\.id)).count, 25)
        for item in RPG.catalog {
            hero.owned.append(item.id)
            try hero.equip(item.id, in: item.slot)
            XCTAssertEqual(hero.item(item.slot), item)
            for frame in 0...1 {
                XCTAssertTrue(RPG.pixels(hero: hero, frame: frame).allSatisfy { (0..<12).contains($0.x) && (0..<12).contains($0.y) })
            }
        }
        XCTAssertThrowsError(try hero.equip("hat-legendary", in: .skin))
        try hero.equip(nil, in: .hat)
        XCTAssertNil(hero.item(.hat))
        hero.owned.append("future-skin")
        hero.equipped["skin"] = "future-skin"
        XCTAssertNil(hero.item(.skin))
        try hero.validate()
        XCTAssertEqual(try JSONDecoder().decode(RPG.State.self, from: JSONEncoder().encode(hero)), hero)
        hero.version = 2
        XCTAssertThrowsError(try hero.validate())
    }

    func testOpeningAndUpgradeRetriesKeepTheFirstResult() throws {
        var hero = RPG.State()
        for i in 0..<4 { try hero.award(RPG.Reward(kind: .poolTask, source: "\(i)", at: "2026-10-28")) }
        try hero.openBooster("level-2", item: "hat-rare")
        try hero.openBooster("level-2", item: "hat-legendary")
        XCTAssertEqual(hero.openings["level-2"]?.item, "hat-rare")
        XCTAssertFalse(hero.owned.contains("hat-legendary"))
        XCTAssertTrue(hero.boosters.isEmpty)
        try hero.upgrade("health", rank: 1)
        try hero.upgrade("health", rank: 1)
        XCTAssertEqual(hero.sparks, 10)
        XCTAssertThrowsError(try hero.upgrade("health", rank: 2))
        XCTAssertEqual(hero.upgrades["health"], 1)
    }

    func testTypeScriptEncryptedHeroAndIdentity() throws {
        struct Fixture: Decodable {
            var key: String
            var blob: String
            var state: RPG.State
            var reward: RPG.Reward
            var completion: PoolCompletion
        }
        let path = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("shared/test/rpg-vectors.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: path))
        let opened = try E2E.open(fixture.blob, as: RPG.State.self, with: E2E.key(fromBase64URL: fixture.key))
        XCTAssertEqual(opened, fixture.state)
        try opened.validate()
        XCTAssertEqual(fixture.reward, RPG.Reward(kind: .task, source: "session\nFix the test", at: "2026-10-28"))
        XCTAssertEqual(fixture.completion.assignee.account, "author")
        XCTAssertEqual(fixture.completion.reviewer?.account, "reviewer")
    }
}
