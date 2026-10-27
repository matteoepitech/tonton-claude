import XCTest

@testable import TontonCore

final class UsageExportTests: XCTestCase {
    private var calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Paris") ?? .current
        return calendar
    }()
    /// Sunday 1 November 2026, 10:00 in Paris: the first day of a month.
    private let firstOfMonth = Date(timeIntervalSince1970: 1_793_523_600)
    /// Monday 26 October 2026, 10:00 in Paris.
    private let now = Date(timeIntervalSince1970: 1_793_005_200)

    private func history(_ entries: [[String: Any]]) throws -> UsageHistory {
        let full = entries.map { entry in
            [
                "machine": "PC", "project": "api", "costUSD": 1.0,
                "tokens": ["input": 10, "output": 20, "cacheRead": 30, "cacheWrite": 40],
            ].merging(entry) { _, new in new }
        }
        let data = try JSONSerialization.data(withJSONObject: ["entries": full, "readings": [:]])
        return try JSONDecoder().decode(UsageHistory.self, from: data)
    }

    func testOneRowPerDayMachineProjectAndToolWithADotForDecimals() throws {
        let usage = try history([
            ["day": "2026-10-26", "machine": "Studio", "costUSD": 0.125],
            ["day": "2026-10-25", "tool": "opencode", "costUSD": 2],
        ])
        let csv = UsageExport.csv(usage, range: .lastWeek, until: now, calendar: calendar)
        XCTAssertEqual(
            csv,
            "date,machine,project,tool,cost_usd,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens\r\n"
                + "2026-10-25,PC,api,OpenCode,2.0000,10,20,30,40\r\n"
                + "2026-10-26,Studio,api,Claude Code,0.1250,10,20,30,40\r\n")
    }

    func testNamesWithCommasQuotesLineBreaksOrFormulasStayOneField() {
        XCTAssertEqual(UsageExport.field("api"), "api")
        XCTAssertEqual(UsageExport.field("shop, web"), "\"shop, web\"")
        XCTAssertEqual(UsageExport.field("the \"big\" one"), "\"the \"\"big\"\" one\"")
        XCTAssertEqual(UsageExport.field("two\nlines"), "\"two\nlines\"")
        XCTAssertEqual(UsageExport.field("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"")
        XCTAssertEqual(UsageExport.field("+1"), "'+1")
        XCTAssertEqual(UsageExport.field("@sum"), "'@sum")
    }

    func testRangesFollowTheCalendarAcrossMonths() {
        XCTAssertEqual(UsageExport.Range.lastWeek.days(until: now, calendar: calendar), "2026-10-20"..."2026-10-26")
        XCTAssertEqual(UsageExport.Range.lastMonthDays.days(until: now, calendar: calendar), "2026-09-27"..."2026-10-26")
        XCTAssertEqual(UsageExport.Range.thisMonth.days(until: now, calendar: calendar), "2026-10-01"..."2026-10-26")
        XCTAssertEqual(UsageExport.Range.lastMonth.days(until: now, calendar: calendar), "2026-09-01"..."2026-09-30")
        // On the first of a month, this month is that one day and last month is the whole previous one.
        XCTAssertEqual(UsageExport.Range.thisMonth.days(until: firstOfMonth, calendar: calendar), "2026-11-01"..."2026-11-01")
        XCTAssertEqual(UsageExport.Range.lastMonth.days(until: firstOfMonth, calendar: calendar), "2026-10-01"..."2026-10-31")
        XCTAssertEqual(UsageExport.Range.lastWeek.days(until: firstOfMonth, calendar: calendar), "2026-10-26"..."2026-11-01")
        XCTAssertNil(UsageExport.Range.everything.days(until: now, calendar: calendar))
    }

    func testTheRangeKeepsOnlyItsDays() throws {
        let usage = try history([
            ["day": "2026-08-31"], ["day": "2026-09-01"], ["day": "2026-09-30"], ["day": "2026-10-01"],
        ])
        let rows = { (range: UsageExport.Range) in
            UsageExport.csv(usage, range: range, until: self.now, calendar: self.calendar)
                .components(separatedBy: "\r\n").dropFirst().filter { !$0.isEmpty }.map { String($0.prefix(10)) }
        }
        XCTAssertEqual(rows(.lastMonth), ["2026-09-01", "2026-09-30"])
        XCTAssertEqual(rows(.thisMonth), ["2026-10-01"])
        XCTAssertEqual(rows(.everything), ["2026-08-31", "2026-09-01", "2026-09-30", "2026-10-01"])
        XCTAssertEqual(rows(.lastWeek), [])
    }

    func testAnEmptyRangeIsTheHeaderAlone() {
        XCTAssertEqual(
            UsageExport.csv(UsageHistory(), range: .everything, until: now, calendar: calendar),
            "date,machine,project,tool,cost_usd,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens\r\n")
    }

    func testNumbersUseADotWhateverTheLanguage() throws {
        // String(format:) is not localized: a French Mac still writes 1.5000, never 1,5000.
        let usage = try history([["day": "2026-10-26", "costUSD": 1.5]])
        XCTAssertTrue(UsageExport.csv(usage, range: .lastWeek, until: now, calendar: calendar).contains(",1.5000,"))
    }

    func testFileNames() {
        XCTAssertEqual(UsageExport.fileName(.lastMonth, until: now, calendar: calendar), "tonton-usage-2026-09.csv")
        XCTAssertEqual(UsageExport.fileName(.thisMonth, until: now, calendar: calendar), "tonton-usage-2026-10.csv")
        XCTAssertEqual(UsageExport.fileName(.lastWeek, until: now, calendar: calendar), "tonton-usage-2026-10-20-to-2026-10-26.csv")
        XCTAssertEqual(UsageExport.fileName(.everything, until: now, calendar: calendar), "tonton-usage.csv")
    }
}
