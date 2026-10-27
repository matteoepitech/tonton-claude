import XCTest

@testable import TontonCore

final class LimitForecastTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_793_000_000)
    private func at(_ minutes: Double) -> Date { start + minutes * 60 }
    private var reset: Date { at(180) }

    func testAPaceThatEndsBeforeTheResetGivesTheTimeItRunsOut() throws {
        var forecast = LimitForecast()
        // 1 % a minute for 10 minutes: from 60 %, 40 minutes left.
        for minute in 0...10 {
            forecast.record([UsageLimit(usedPercent: 50 + Double(minute), resetsAt: reset)], at: at(Double(minute)))
        }
        let now = UsageLimit(usedPercent: 60, resetsAt: reset)
        let end = try XCTUnwrap(forecast.runsOut(now, at: at(10)))
        XCTAssertEqual(end.timeIntervalSince(at(10)), 40 * 60, accuracy: 1)
    }

    func testNothingWhenItWouldResetFirstIsntRisingOrKnowsTooLittle() {
        var forecast = LimitForecast()
        // 0.1 % a minute: 400 minutes left, the window resets in 170.
        for minute in 0...10 {
            forecast.record([UsageLimit(usedPercent: 60 + Double(minute) / 10, resetsAt: reset)], at: at(Double(minute)))
        }
        XCTAssertNil(forecast.runsOut(UsageLimit(usedPercent: 61, resetsAt: reset), at: at(10)))

        var flat = LimitForecast()
        for minute in 0...10 { flat.record([UsageLimit(usedPercent: 60, resetsAt: reset)], at: at(Double(minute))) }
        XCTAssertNil(flat.runsOut(UsageLimit(usedPercent: 60, resetsAt: reset), at: at(10)))

        var short = LimitForecast()
        for minute in 0...3 { short.record([UsageLimit(usedPercent: 60 + Double(minute) * 5, resetsAt: reset)], at: at(Double(minute))) }
        XCTAssertNil(short.runsOut(UsageLimit(usedPercent: 75, resetsAt: reset), at: at(3)))
        XCTAssertNil(short.runsOut(UsageLimit(usedPercent: 100, resetsAt: reset), at: at(3)))
    }

    func testOnlyTheLastHalfHourCountsAndEachWindowApart() throws {
        var forecast = LimitForecast()
        // A burst long ago, then calm: the pace is the calm one.
        forecast.record([UsageLimit(usedPercent: 10, resetsAt: reset)], at: at(0))
        forecast.record([UsageLimit(usedPercent: 50, resetsAt: reset)], at: at(5))
        for minute in stride(from: 40.0, through: 60, by: 5) {
            forecast.record([UsageLimit(usedPercent: 50, resetsAt: reset)], at: at(minute))
        }
        XCTAssertNil(forecast.runsOut(UsageLimit(usedPercent: 50, resetsAt: reset), at: at(60)))
        // Another plan's window isn't mixed in.
        let other = at(200)
        for minute in 0...10 {
            forecast.record([UsageLimit(usedPercent: 20 + Double(minute) * 2, resetsAt: other)], at: at(60 + Double(minute)))
        }
        XCTAssertNotNil(forecast.runsOut(UsageLimit(usedPercent: 40, resetsAt: other), at: at(70)))
        XCTAssertNil(forecast.runsOut(UsageLimit(usedPercent: 50, resetsAt: reset), at: at(70)))
        // Once a window resets, its readings go.
        forecast.record([], at: at(181))
        XCTAssertNil(forecast.runsOut(UsageLimit(usedPercent: 50, resetsAt: reset), at: at(181)))
    }
}
