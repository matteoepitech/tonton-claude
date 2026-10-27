import XCTest

@testable import TontonCore

final class LimitForecastTests: XCTestCase {
    /// 14:00 UTC.
    private let start = Date(timeIntervalSince1970: 1_793_109_600)
    private func at(_ minutes: Double) -> Date { start.addingTimeInterval(minutes * 60) }
    private func limit(_ percent: Double, resetsAt minutes: Double = 240) -> UsageLimit {
        UsageLimit(usedPercent: percent, resetsAt: at(minutes))
    }

    func testASteadyPaceRunsOutBeforeTheReset() throws {
        var history = LimitHistory()
        // 1 % a minute from 40 % at 14:00: 100 % at 15:00, long before the reset at 18:00.
        for minute in stride(from: 0.0, through: 30, by: 5) { history.record(limit(40 + minute), at: at(minute)) }
        XCTAssertEqual(history.forecast(for: limit(70), at: at(31)), .runsOut(at(60)))
        let utc = try XCTUnwrap(TimeZone(identifier: "UTC"))
        let text = history.forecast(for: limit(70), at: at(31))?.text(timeZone: utc, locale: Locale(identifier: "en_GB"))
        XCTAssertEqual(text, "Runs out around 15:00")
    }

    func testASlowPaceLastsUntilTheReset() {
        var history = LimitHistory()
        // 0.1 % a minute from 20 %: 100 % would come after the reset.
        for minute in stride(from: 0.0, through: 40, by: 10) { history.record(limit(20 + minute / 10), at: at(minute)) }
        XCTAssertEqual(history.forecast(for: limit(24), at: at(41)), .lastsUntilReset)
        XCTAssertEqual(LimitHistory.Forecast.lastsUntilReset.text(), "Lasts until the reset")
    }

    func testTooLittleToGoByGivesNothing() {
        var history = LimitHistory()
        XCTAssertNil(history.forecast(for: limit(50), at: at(0)))
        history.record(limit(50), at: at(0))
        history.record(limit(52), at: at(5))
        // Two readings, five minutes apart: not a pace yet.
        XCTAssertNil(history.forecast(for: limit(52), at: at(6)))
        // Flat usage: the same percent again adds nothing.
        var flat = LimitHistory()
        for minute in stride(from: 0.0, through: 30, by: 5) { flat.record(limit(50), at: at(minute)) }
        XCTAssertNil(flat.forecast(for: limit(50), at: at(31)))
    }

    func testAStaleReadingOrAReachedLimitGivesNothing() {
        var history = LimitHistory()
        for minute in stride(from: 0.0, through: 30, by: 10) { history.record(limit(40 + minute), at: at(minute)) }
        XCTAssertNotNil(history.forecast(for: limit(70), at: at(35)))
        // Nothing new for 20 minutes: the sessions may have stopped.
        XCTAssertNil(history.forecast(for: limit(70), at: at(50)))
        XCTAssertNil(history.forecast(for: limit(100), at: at(31)))
    }

    func testANewWindowStartsOverAndTheOldOneIsForgotten() {
        var history = LimitHistory()
        // The old window, nearly full, resets at 14:30.
        for minute in stride(from: 0.0, through: 20, by: 10) { history.record(limit(80 + minute / 2, resetsAt: 30), at: at(minute)) }
        // The new window starts low at 14:31: nothing to go by yet, the old pace does not count.
        history.record(limit(2, resetsAt: 330), at: at(31))
        XCTAssertNil(history.forecast(for: limit(2, resetsAt: 330), at: at(32)))
        for minute in stride(from: 41.0, through: 61, by: 10) {
            history.record(limit(2 + (minute - 31) / 2, resetsAt: 330), at: at(minute))
        }
        // 0.5 % a minute from 17 % at 15:01: 100 % at 17:47, rounded to 17:45.
        XCTAssertEqual(history.forecast(for: limit(17, resetsAt: 330), at: at(62)), .runsOut(at(225)))
    }

    func testAReadingThatGoesDownWithinAWindowDropsWhatCameBefore() {
        var history = LimitHistory()
        history.record(limit(60), at: at(0))
        history.record(limit(70), at: at(10))
        history.record(limit(30), at: at(20))
        history.record(limit(31), at: at(25))
        XCTAssertNil(history.forecast(for: limit(31), at: at(26)))
    }

    func testTheEstimateIsRoundedToFiveMinutes() {
        var history = LimitHistory()
        // 1 % every 2 minutes from 0 % at 14:00: 100 % at 17:20, read as 17:20; from 1 % at 14:02 it is 17:22 → 17:20.
        history.record(limit(1), at: at(2))
        history.record(limit(11), at: at(22))
        XCTAssertEqual(history.forecast(for: limit(11), at: at(23)), .runsOut(at(200)))
    }
}
