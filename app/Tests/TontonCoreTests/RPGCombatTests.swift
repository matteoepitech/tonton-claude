import Foundation
import XCTest

@testable import TontonCore

final class RPGCombatTests: XCTestCase {
    func testLootBoundariesAndUpgradeStats() throws {
        for (index, roll) in [0.0, 0.6, 0.85, 0.95, 0.99].enumerated() {
            XCTAssertEqual(try RPG.draw(roll: roll, pick: 0).rarity, RPG.Rarity.allCases[index])
            XCTAssertEqual(try RPG.draw(roll: roll, pick: 0.9999).slot, .trail)
        }
        XCTAssertThrowsError(try RPG.draw(roll: 1, pick: 0))
        XCTAssertThrowsError(try RPG.draw(roll: 0, pick: 0, odds: [60, 25, 10, 4, 2]))
        var hero = RPG.State(); hero.sparks = 10
        try hero.upgrade("health", rank: 1)
        XCTAssertEqual(RPG.Stats(hero: hero).health, 115)
        XCTAssertEqual(hero.sparks, 0)
        try hero.upgrade("health", rank: 1)
        XCTAssertThrowsError(try hero.upgrade("health", rank: 2))
    }
    func testFrameIndependentMovementPauseAndBoundaries() throws {
        var a = RPGCombat(hero: RPG.State(), id: "run", startedAt: "2026-10-28", seed: 42)
        var b = a
        a.resume(); b.resume()
        for _ in 0..<60 { a.advance(1.0 / 60, input: .init(x: 1)) }
        for _ in 0..<30 { b.advance(1.0 / 30, input: .init(x: 1)) }
        XCTAssertEqual(a.x, b.x, accuracy: 0.0001)
        XCTAssertEqual(a.health, b.health)
        a.pause(); let paused = a
        a.advance(100, input: .init(x: 1, attack: true))
        XCTAssertEqual(a, paused)
        a.resume()
        for _ in 0..<200 { a.advance(1.0 / 60, input: .init(x: 1, y: -1)) }
        XCTAssertLessThanOrEqual(a.x, 624); XCTAssertGreaterThanOrEqual(a.y, 16)
        let restored = try JSONDecoder().decode(RPGCombat.self, from: JSONEncoder().encode(a))
        XCTAssertEqual(restored, a)
    }
    func testDefeatHasNoRewardsAndVictoryIsReplaySafe() throws {
        var idle = RPGCombat(hero: RPG.State(), seed: 4); idle.resume()
        for _ in 0..<20_000 where idle.phase == .playing { idle.advance(1.0 / 60, input: .init()) }
        XCTAssertEqual(idle.phase, .lost)
        XCTAssertTrue(idle.rewards().isEmpty)
        // A scripted player exercises actual movement, targeting and dodging, with base and upgraded heroes.
        for rank in [0, 5] {
            var hero = RPG.State(); hero.upgrades = ["health": rank, "attack": rank, "movement": rank]
            var run = RPGCombat(hero: hero, id: "win-\(rank)", startedAt: "2026-10-28", seed: 42)
            run.resume()
            for _ in 0..<36_000 where run.phase == .playing {
                let target = run.enemies.min { hypot($0.x - run.x, $0.y - run.y) < hypot($1.x - run.x, $1.y - run.y) }
                var dx = (target?.x ?? run.x) - run.x; var dy = (target?.y ?? run.y) - run.y
                if let warning = run.enemies.first(where: { $0.warning > 0 && hypot(run.x - $0.targetX, run.y - $0.targetY) < 90 }) {
                    dx = run.x >= warning.targetX ? 1 : -1
                    dy = run.y >= warning.targetY ? 1 : -1
                } else if hypot(dx, dy) < 55 {
                    dx = 0; dy = 0
                }
                let length = max(1, hypot(dx, dy))
                run.advance(1.0 / 60, input: .init(x: dx / length, y: dy / length, attack: true, ability: true))
                XCTAssertLessThanOrEqual(run.enemies.count, 4)
            }
            XCTAssertEqual(run.phase, .won, "rank \(rank), hp \(run.health)")
            let rewards = run.rewards()
            for reward in rewards { try hero.award(reward) }
            let once = hero
            for reward in rewards { try hero.award(reward) }
            XCTAssertEqual(hero, once)
            XCTAssertEqual(hero.xp, 105)
            XCTAssertEqual(hero.sparks, 14)
            XCTAssertTrue(hero.boosters.contains { $0.hasPrefix("boss-v1-") })
            try hero.claimMilestones()
            XCTAssertTrue(hero.boosters.contains("achievement-v1-rpgBoss"))
        }
    }
}
