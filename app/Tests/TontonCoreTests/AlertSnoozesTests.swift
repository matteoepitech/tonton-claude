import XCTest

@testable import TontonCore

final class AlertSnoozesTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_793_000_000)

    func testATimedSnoozeMutesEverythingButPermissionsUntilItEnds() {
        var snoozes = AlertSnoozes()
        snoozes.snooze("s1", for: .quarterHour, now: now)
        let during = now.addingTimeInterval(14 * 60)
        XCTAssertTrue(snoozes.isSnoozed("s1", at: during))
        XCTAssertEqual(snoozes.end(of: "s1"), now.addingTimeInterval(15 * 60))
        XCTAssertFalse(snoozes.allows(.finished, for: "s1", at: during))
        XCTAssertFalse(snoozes.allows(.needsYou(.waiting), for: "s1", at: during))
        XCTAssertFalse(snoozes.allows(.needsYou(.error), for: "s1", at: during))
        XCTAssertFalse(snoozes.allows(.limitReset, for: "s1", at: during))
        XCTAssertTrue(snoozes.allows(.needsYou(.permission), for: "s1", at: during))
        // Other sessions are not muted.
        XCTAssertTrue(snoozes.allows(.finished, for: "s2", at: during))
        let after = now.addingTimeInterval(15 * 60 + 1)
        XCTAssertFalse(snoozes.isSnoozed("s1", at: after))
        XCTAssertTrue(snoozes.allows(.finished, for: "s1", at: after))
    }

    func testAnHourIsAnHour() {
        var snoozes = AlertSnoozes()
        snoozes.snooze("s1", for: .hour, now: now)
        XCTAssertTrue(snoozes.isSnoozed("s1", at: now.addingTimeInterval(3599)))
        XCTAssertFalse(snoozes.isSnoozed("s1", at: now.addingTimeInterval(3601)))
    }

    func testUntilItFinishesLetsTheFinishThroughThenEnds() {
        var snoozes = AlertSnoozes()
        snoozes.snooze("s1", for: .untilFinished, now: now)
        let later = now.addingTimeInterval(5 * 3600)
        XCTAssertTrue(snoozes.isSnoozed("s1", at: later))
        XCTAssertNil(snoozes.end(of: "s1"))
        XCTAssertFalse(snoozes.allows(.needsYou(.waiting), for: "s1", at: later))
        XCTAssertTrue(snoozes.allows(.needsYou(.permission), for: "s1", at: later))
        XCTAssertTrue(snoozes.allows(.finished, for: "s1", at: later))
        XCTAssertFalse(snoozes.isSnoozed("s1", at: later))
        XCTAssertTrue(snoozes.allows(.needsYou(.waiting), for: "s1", at: later))
    }

    func testWakingAndPruning() {
        var snoozes = AlertSnoozes()
        snoozes.snooze("s1", for: .untilFinished, now: now)
        snoozes.snooze("s2", for: .quarterHour, now: now)
        snoozes.snooze("s3", for: .hour, now: now)
        snoozes.wake("s1")
        XCTAssertFalse(snoozes.isSnoozed("s1", at: now))
        snoozes.snooze("s1", for: .untilFinished, now: now)
        // s1 ended (not live any more), s2 ran out, s3 still runs.
        snoozes.prune(keeping: ["s2", "s3"], at: now.addingTimeInterval(20 * 60))
        XCTAssertEqual(snoozes.isSnoozed("s1", at: now), false)
        XCTAssertEqual(snoozes.isSnoozed("s2", at: now), false)
        XCTAssertTrue(snoozes.isSnoozed("s3", at: now.addingTimeInterval(20 * 60)))
        XCTAssertEqual(AlertSnoozes.Length.allCases.map(\.label), ["15 minutes", "1 hour", "Until it finishes"])
    }
}
