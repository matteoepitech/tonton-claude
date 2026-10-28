import Foundation
import XCTest

@testable import TontonCore

final class RPGPoolTests: XCTestCase {
    func testTypeScriptLootAndTeamLedgerSurviveReplayAndPeriods() throws {
        struct Fixture: Decodable { let key: String; let hero: String; let ledger: String }
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("shared/test/rpg-gameplay-vectors.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: file))
        let key = try E2E.key(fromBase64URL: fixture.key)
        var hero = try E2E.open(fixture.hero, as: RPG.State.self, with: key)
        var ledger = try E2E.open(fixture.ledger, as: RPGPoolLedger.self, with: key)
        try hero.validate(); try ledger.validate()
        XCTAssertEqual(hero.openings.values.first?.tableVersion, 1)
        XCTAssertTrue(hero.owned.contains("hat-legendary"))
        let vault = try PoolVault(key: fixture.key)
        var info = PoolInfo(name: "Demo"); info.startedAt = "2026-10-28T10:00:00.000Z"
        let snapshot = PoolSnapshot(
            id: "demopool0001", createdAt: info.startedAt ?? "", paused: false, keyVersion: 1,
            info: try vault.seal(info), members: [PoolMemberWire(account: "alice", role: .owner, joinedAt: "", profile: nil)],
            sessions: [], tasks: [], notes: nil, messages: [], events: [], own: nil, rules: nil, budgets: nil, audit: nil, orchestrator: nil
        )
        var state = PoolState(snapshot: snapshot, vault: vault)
        try ledger.sync(state, account: "alice", hero: hero)
        XCTAssertEqual(ledger.completions.count, 3)
        XCTAssertEqual(ledger.standings(state, since: RPGPoolLedger.runStart(state)).map(\.xp), [120, 90])
        XCTAssertTrue(ledger.standings(state, since: "").contains { $0.id == "bob" && $0.departed })
        try ledger.claim(&hero, account: "bob")
        let once = hero
        try ledger.claim(&hero, account: "bob")
        XCTAssertEqual(hero, once)
        state.info?.startedAt = "2026-10-29T00:00:00Z"
        XCTAssertTrue(ledger.standings(state, since: RPGPoolLedger.runStart(state)).allSatisfy { $0.xp == 0 })
        XCTAssertEqual(ledger.standings(state, since: "").map(\.xp), [120, 90])
        XCTAssertEqual(ledger.completedCount(since: "2026-10-28T10:01:00Z"), 3)
        var invalid = ledger; invalid.version = 99
        XCTAssertThrowsError(try invalid.validate())
    }
}
