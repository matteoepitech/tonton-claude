import XCTest

@testable import TontonCore

/// The logic under the notch's hero screen: the ring's caption, the wardrobe's clicks, the journal's words and the day.
final class HeroScreenTests: XCTestCase {
    // The plurals only exist in the compiled catalog.
    override func setUpWithError() throws { try Catalog.use("en") }
    override func tearDown() { Catalog.reset() }

    private func hero(xp: Int) -> RPG.State {
        var state = RPG.State()
        state.xp = xp
        return state
    }

    func testXPToTheNextLevel() {
        // Level 7 starts at 2,100 XP, level 8 at 2,800.
        XCTAssertEqual(hero(xp: 2_570).level, 7)
        XCTAssertEqual(hero(xp: 2_570).xpToNextLevel, 230)
        XCTAssertEqual(hero(xp: 0).xpToNextLevel, 100)
        XCTAssertNil(hero(xp: RPG.threshold(100)).xpToNextLevel)
        XCTAssertNil(hero(xp: RPG.threshold(100) + 5_000).xpToNextLevel)
    }

    func testTheFirstClickTriesOnTheSecondWears() throws {
        var state = RPG.State()
        state.owned = ["hat-rare"]
        let rare = try XCTUnwrap(RPG.catalog.first { $0.id == "hat-rare" })
        let epic = try XCTUnwrap(RPG.catalog.first { $0.id == "hat-epic" })
        XCTAssertEqual(WardrobeTap(rare, previewing: nil, hero: state), .preview("hat-rare"))
        XCTAssertEqual(WardrobeTap(rare, previewing: "hat-epic", hero: state), .preview("hat-rare"))
        XCTAssertEqual(WardrobeTap(rare, previewing: "hat-rare", hero: state), .equip("hat-rare"))
        try state.equip("hat-rare", in: .hat)
        XCTAssertEqual(WardrobeTap(rare, previewing: "hat-rare", hero: state), .unequip(.hat))
        // Not owned: it can be looked at, never worn.
        XCTAssertEqual(WardrobeTap(epic, previewing: "hat-epic", hero: state), .preview("hat-epic"))
    }

    private func entry(_ kind: RPG.Kind, xp: Int = 10, seconds: Int? = nil, note: String? = nil, at: String? = nil) -> RPG.JournalEntry {
        RPG.JournalEntry(id: "x", kind: kind, xp: xp, sparks: 1, day: "2026-11-04", at: at, seconds: seconds, note: note)
    }

    func testTheJournalSaysWhy() {
        XCTAssertEqual(entry(.turn, xp: 18, seconds: 13 * 60 + 20, note: "tonton-claude").reason, "13 minutes of work in tonton-claude")
        XCTAssertEqual(entry(.turn, seconds: 61, note: "web").reason, "1 minute of work in web")
        XCTAssertEqual(entry(.turn, seconds: 600).reason, "10 minutes of work")
        XCTAssertEqual(entry(.turn, xp: 5, seconds: 40, note: "web").reason, "answered prompt")
        XCTAssertEqual(entry(.turn, xp: 1).reason, "answered prompt")
        XCTAssertEqual(entry(.push, xp: 15, note: "main").reason, "pushed main")
        XCTAssertEqual(entry(.push, xp: 15).reason, "pushed commits")
        XCTAssertEqual(entry(.day, xp: 40).reason, "first turn of the day")
        XCTAssertEqual(entry(.task).reason, "checklist task")
        for kind in [RPG.Kind.poolTask, .review, .encounter, .boss] { XCTAssertFalse(entry(kind).reason.isEmpty) }
    }

    func testAJournalEntryHasATime() throws {
        let timed = try XCTUnwrap(entry(.turn, at: "2026-11-04T15:42:10Z").date)
        XCTAssertEqual(timed.timeIntervalSince1970, 1_793_806_930)
        // Older receipts only know their day.
        XCTAssertEqual(try XCTUnwrap(entry(.task).date).timeIntervalSince1970, 1_793_793_600)
    }

    /// Claude Code writes milliseconds: those gains all showed at noon UTC (13:00 in Paris) instead of their own time.
    func testAJournalTimeWithMillisecondsOrMinutesOnly() throws {
        let precise = try XCTUnwrap(entry(.turn, at: "2026-11-04T15:42:10.123Z").date)
        XCTAssertEqual(precise.timeIntervalSince1970, 1_793_806_930, accuracy: 0.001)
        let minutes = try XCTUnwrap(entry(.turn, at: "2026-11-04T15:42Z").date)
        XCTAssertEqual(minutes.timeIntervalSince1970, 1_793_806_920)
        let nanos = try XCTUnwrap(entry(.turn, at: "2026-11-04T15:42:10.123456789Z").date)
        XCTAssertEqual(nanos.timeIntervalSince1970, 1_793_806_930, accuracy: 0.001)
    }

    func testTheBarsRunThroughTheUTCDay() throws {
        let day = RPG.Today(day: "2026-11-04", xp: 0, streak: 0, hours: Array(repeating: 0, count: 24))
        let start = try XCTUnwrap(day.start)
        XCTAssertEqual(start.timeIntervalSince1970, 1_793_750_400)
        XCTAssertEqual(day.hour(of: start), 0)
        XCTAssertEqual(day.hour(of: start.addingTimeInterval(15 * 3600 + 59 * 60)), 15)
        XCTAssertEqual(day.hour(of: start.addingTimeInterval(24 * 3600 - 1)), 23)
        XCTAssertNil(day.hour(of: start.addingTimeInterval(24 * 3600)))
        XCTAssertNil(day.hour(of: start.addingTimeInterval(-1)))
    }

    func testTheStreakLightsTodayOnceItsFirstTurnCounted() throws {
        var state = RPG.State()
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-11-04T10:00:00Z"))
        state.gains = [RPG.Receipt(id: String(repeating: "a", count: 64), kind: .day, day: "2026-11-03", xp: 20, sparks: 2)]
        XCTAssertFalse(state.playedToday(now: now))
        state.gains.append(RPG.Receipt(id: String(repeating: "b", count: 64), kind: .day, day: "2026-11-04", xp: 30, sparks: 3))
        XCTAssertTrue(state.playedToday(now: now))
    }
}
