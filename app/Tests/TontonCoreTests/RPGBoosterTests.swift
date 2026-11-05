import XCTest

@testable import TontonCore

final class RPGBoosterTests: XCTestCase {
    func testEachBoosterSaysWhereItComesFrom() {
        XCTAssertEqual(RPG.BoosterSource("level-12"), .level(12))
        XCTAssertEqual(RPG.BoosterSource("boss-v1-rpg-boss-2026-11-05"), .boss)
        XCTAssertEqual(RPG.BoosterSource("achievement-v1-rpgWorker"), .achievement)
        XCTAssertEqual(RPG.BoosterSource("team-v1-pool-25"), .team)
        XCTAssertEqual(RPG.BoosterSource("level-x"), .other)
        XCTAssertEqual(RPG.BoosterSource("level-7").label, "Level 7")
    }

    func testPastOpeningsGoFromTheHighestLevelDown() {
        let order = RPG.openingOrder(["level-2", "team-v1-a", "level-10", "boss-v1-b", "level-9"])
        XCTAssertEqual(order, ["level-10", "level-9", "level-2", "boss-v1-b", "team-v1-a"])
    }

    func testOpenAllOpensEveryBoosterInOneChange() throws {
        var hero = RPG.State()
        hero.boosters = ["level-2", "level-3", "boss-v1-x"]
        hero.owned = ["hat-common"]
        try hero.openBoosters(["level-2": "hat-common", "level-3": "skin-legendary", "boss-v1-x": "hat-rare"])
        XCTAssertEqual(hero.boosters, [])
        XCTAssertEqual(hero.openings["level-2"], RPG.Opening(item: "hat-common", duplicateSparks: 1))
        XCTAssertEqual(hero.openings["level-3"]?.item, "skin-legendary")
        XCTAssertEqual(hero.sparks, 1)
        XCTAssertEqual(Set(hero.owned), ["hat-common", "skin-legendary", "hat-rare"])
    }

    func testABoosterOpenedElsewhereKeepsItsFirstDrop() throws {
        var hero = RPG.State()
        hero.boosters = ["level-3"]
        hero.openings = ["level-2": RPG.Opening(item: "hat-epic", duplicateSparks: 0)]
        try hero.openBoosters(["level-2": "skin-common", "level-3": "hat-uncommon"])
        XCTAssertEqual(hero.openings["level-2"]?.item, "hat-epic")
        XCTAssertEqual(hero.openings["level-3"]?.item, "hat-uncommon")
    }

    func testDrawsGiveEveryBoosterAnItemOfTheCatalog() throws {
        let draws = try RPG.draws(for: ["level-2", "level-3", "level-2"])
        XCTAssertEqual(Set(draws.keys), ["level-2", "level-3"])
        XCTAssertTrue(draws.values.allSatisfy { id in RPG.catalog.contains { $0.id == id } })
    }
}
