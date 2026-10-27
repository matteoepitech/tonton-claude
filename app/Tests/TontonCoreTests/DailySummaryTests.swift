import XCTest

@testable import TontonCore

final class DailySummaryTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Paris") ?? .current
        return calendar
    }
    private func at(_ day: Int, _ hour: Int, _ minute: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour, minute: minute)) ?? .distantPast
    }

    func testOnceADayFromItsTime() {
        let six = 18 * 60
        XCTAssertFalse(DailySummary.isDue(at: at(27, 17, 59), minutes: six, lastDay: "2026-10-26", calendar: calendar))
        XCTAssertTrue(DailySummary.isDue(at: at(27, 18), minutes: six, lastDay: "2026-10-26", calendar: calendar))
        XCTAssertTrue(DailySummary.isDue(at: at(27, 23, 30), minutes: six, lastDay: "", calendar: calendar))
        XCTAssertFalse(DailySummary.isDue(at: at(27, 23, 30), minutes: six, lastDay: "2026-10-27", calendar: calendar))
        // Asleep through the evening: the next morning is too early for the next one, and yesterday's is gone.
        XCTAssertFalse(DailySummary.isDue(at: at(28, 8), minutes: six, lastDay: "2026-10-26", calendar: calendar))
    }

    func testWhatTheDayAddsUpTo() {
        XCTAssertEqual(DailySummary.text(worked: 3 * 3600 + 20 * 60, sessions: 5, cost: 12.4), "3 h 20 of work in 5 sessions, $12.40.")
        XCTAssertEqual(DailySummary.text(worked: 42 * 60, sessions: 1, cost: nil), "42 min of work in 1 session.")
        XCTAssertEqual(DailySummary.text(worked: 0, sessions: 2, cost: 0), "No task finished in 2 sessions.")
        XCTAssertNil(DailySummary.text(worked: 20, sessions: 0, cost: 3))
    }
}
