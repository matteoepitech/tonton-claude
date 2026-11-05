import Foundation
import XCTest

@testable import TontonCore

final class RPGPagesTests: XCTestCase {
    func testAStatsRankValueAndPrice() {
        var hero = RPG.State()
        hero.sparks = 25
        hero.upgrades = ["attack": 2]
        let health = RPG.Upgrade(.health, of: hero)
        XCTAssertEqual([health.rank, health.value, health.next, health.price], [0, 100, 115, 10])
        XCTAssertTrue(health.affordable)
        let attack = RPG.Upgrade(.attack, of: hero)
        XCTAssertEqual([attack.rank, attack.value, attack.next, attack.price], [2, 21, 24, 30])
        XCTAssertFalse(attack.affordable)
        hero.upgrades = ["movement": 10]
        let movement = RPG.Upgrade(.movement, of: hero)
        XCTAssertEqual(movement.value, 180)
        XCTAssertNil(movement.next)
        XCTAssertNil(movement.price)
        XCTAssertFalse(movement.affordable)
    }

    func testTheUpgradesPageAgreesWithThePurchase() throws {
        var hero = RPG.State()
        hero.sparks = 100
        for stat in RPG.Stat.allCases {
            let before = RPG.Upgrade(stat, of: hero)
            let sparks = hero.sparks
            try hero.upgrade(stat.rawValue, rank: before.rank + 1)
            XCTAssertEqual(sparks - hero.sparks, before.price)
            XCTAssertEqual(RPG.Upgrade(stat, of: hero).value, before.next)
        }
    }

    func testOnlyReachedUnclaimedMilestonesAreClaimable() throws {
        var hero = RPG.State()
        XCTAssertTrue(hero.claimableMilestones.isEmpty)
        hero.xp = 1200
        XCTAssertEqual(hero.claimableMilestones.map(\.achievement), [.rpgVeteran])
        try hero.claimMilestones()
        XCTAssertTrue(hero.claimableMilestones.isEmpty)
        hero.openings[hero.boosters[0]] = RPG.Opening(item: "hat-common", duplicateSparks: 0)
        hero.boosters = []
        XCTAssertTrue(hero.claimableMilestones.isEmpty)
    }

    func testWhereEachPeriodStarts() throws {
        let vault = try PoolVault(key: String(repeating: "A", count: 43))
        var info = PoolInfo(name: "Jam")
        info.startedAt = "2026-11-01T09:00:00.000Z"
        let snapshot = PoolSnapshot(
            id: "jampool00001", createdAt: "2026-10-30T08:00:00.000Z", paused: false, keyVersion: 1, info: try vault.seal(info),
            members: [], sessions: [], tasks: [], notes: nil, messages: [], events: [], own: nil, rules: nil, budgets: nil, audit: nil,
            orchestrator: nil)
        let state = PoolState(snapshot: snapshot, vault: vault)
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-11-05T22:30:00Z"))
        XCTAssertEqual(RPGPoolLedger.start(of: .all, in: state, now: now), "")
        XCTAssertEqual(RPGPoolLedger.start(of: .run, in: state, now: now), "2026-11-01T09:00:00.000Z")
        XCTAssertEqual(RPGPoolLedger.start(of: .today, in: state, now: now), "2026-11-05T00:00:00Z")
    }
}
