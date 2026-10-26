import XCTest

@testable import TontonCore

final class BusyHoursTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Paris") ?? .current
        calendar.firstWeekday = 2
        return calendar
    }

    private func date(_ day: Int, _ hour: Int, _ minute: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour, minute: minute)) ?? .distantPast
    }

    func testATaskSharesItsTimeBetweenTheHoursItSpanned() {
        var hours = BusyHours()
        // 13:40 to 15:10 on Tuesday, October 20.
        hours.worked(90 * 60, until: date(20, 15, 10), calendar: calendar)
        let day = hours.days["2026-10-20"]
        XCTAssertEqual(day?[13], 20 * 60)
        XCTAssertEqual(day?[14], 60 * 60)
        XCTAssertEqual(day?[15], 10 * 60)
        XCTAssertEqual(day?.reduce(0, +), 90 * 60)
    }

    func testATaskOverMidnightCountsOnBothDays() {
        var hours = BusyHours()
        hours.worked(30 * 60, until: date(21, 0, 10), calendar: calendar)
        XCTAssertEqual(hours.days["2026-10-20"]?[23], 20 * 60)
        XCTAssertEqual(hours.days["2026-10-21"]?[0], 10 * 60)
    }

    func testOddDurationsAreBounded() {
        var hours = BusyHours()
        hours.worked(0, until: date(20, 12), calendar: calendar)
        hours.worked(-5, until: date(20, 12), calendar: calendar)
        hours.worked(.infinity, until: date(20, 12), calendar: calendar)
        XCTAssertTrue(hours.days.isEmpty)
        // A week: only the last day counts.
        hours.worked(7 * 86400, until: date(20, 12), calendar: calendar)
        XCTAssertEqual(hours.days.values.flatMap { $0 }.reduce(0, +), 86400)
    }

    func testTheGridAddsUpEachWeekdayInTheCalendarsOrder() {
        var hours = BusyHours()
        hours.worked(3600, until: date(20, 10), calendar: calendar)  // Tuesday 9:00
        hours.worked(1800, until: date(13, 10), calendar: calendar)  // the Tuesday before
        hours.worked(600, until: date(25, 23), calendar: calendar)  // Sunday 22:50
        let grid = hours.grid(until: date(26, 12), calendar: calendar)
        XCTAssertEqual(grid.map(\.weekday), [2, 3, 4, 5, 6, 7, 1])
        XCTAssertEqual(grid[1].hours[9], 5400)
        XCTAssertEqual(grid[6].hours[22], 600)
        XCTAssertEqual(grid.flatMap(\.hours).reduce(0, +), 6000)
        XCTAssertEqual(BusyHours.busiest(grid)?.weekday, 3)
        XCTAssertEqual(BusyHours.busiest(grid)?.hour, 9)
        XCTAssertNil(BusyHours.busiest(BusyHours().grid(until: date(26, 12), calendar: calendar)))
        // Only the days asked for.
        XCTAssertEqual(hours.grid(days: 7, until: date(26, 12), calendar: calendar)[1].hours[9], 3600)
    }

    func testOnlyThirteenWeeksAreKept() {
        var hours = BusyHours()
        hours.worked(3600, until: date(1, 10), calendar: calendar)
        let later = calendar.date(byAdding: .day, value: BusyHours.keptDays, to: date(1, 10)) ?? .distantFuture
        hours.worked(3600, until: later, calendar: calendar)
        XCTAssertNil(hours.days["2026-10-01"])
        XCTAssertEqual(hours.days.count, 1)
    }

    func testItDecodesWhatItSavedAndSurvivesADamagedDay() throws {
        var hours = BusyHours()
        hours.worked(3600, until: date(20, 10), calendar: calendar)
        XCTAssertEqual(try JSONDecoder().decode(BusyHours.self, from: try JSONEncoder().encode(hours)), hours)
        var damaged = try JSONDecoder().decode(BusyHours.self, from: Data(#"{"days":{"2026-10-20":[1,2]}}"#.utf8))
        XCTAssertEqual(damaged.grid(until: date(20, 12), calendar: calendar).flatMap(\.hours).reduce(0, +), 0)
        damaged.worked(600, until: date(20, 10), calendar: calendar)
        XCTAssertEqual(damaged.days["2026-10-20"]?[9], 600)
    }
}
