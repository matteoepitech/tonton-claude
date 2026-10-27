import XCTest

@testable import TontonCore

final class UsageExportTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Paris") ?? .current
        return calendar
    }
    /// Tuesday, October 27, 2026, at noon in Paris.
    private var now: Date { calendar.date(from: DateComponents(year: 2026, month: 10, day: 27, hour: 12)) ?? .distantPast }

    private func history(_ days: [(String, String, String, Double)]) throws -> UsageHistory {
        let tokens = #""tokens":{"input":1,"output":2,"cacheRead":3,"cacheWrite":4}"#
        let entries = days.map { day, machine, project, cost in
            #"{"day":"\#(day)","machine":"\#(machine)","project":"\#(project)","costUSD":\#(cost),\#(tokens)}"#
        }
        let json = #"{"entries":[\#(entries.joined(separator: ","))],"readings":{}}"#
        return try JSONDecoder().decode(UsageHistory.self, from: Data(json.utf8))
    }

    func testTheRangesEndToday() {
        XCTAssertEqual(UsageExport.Range.week.days(until: now, calendar: calendar)?.first, "2026-10-21")
        XCTAssertEqual(UsageExport.Range.month.days(until: now, calendar: calendar)?.first, "2026-09-28")
        XCTAssertEqual(UsageExport.Range.thisMonth.days(until: now, calendar: calendar)?.first, "2026-10-01")
        let last = UsageExport.Range.lastMonth.days(until: now, calendar: calendar)
        XCTAssertEqual(last?.first, "2026-09-01")
        XCTAssertEqual(last?.last, "2026-09-30")
        XCTAssertNil(UsageExport.Range.all.days(until: now, calendar: calendar))
        XCTAssertEqual(UsageExport.Range.thisMonth.fileName(until: now, calendar: calendar), "tonton-usage-2026-10-01-to-2026-10-27.csv")
    }

    func testOneRowPerDayMachineAndProjectInTheRange() throws {
        let usage = try history([
            ("2026-10-27", "MacBook", "api", 1.5), ("2026-09-30", "PC", "web", 2), ("2026-10-27", "Arch", "api", 0.25),
        ])
        let csv = UsageExport.csv(usage, range: .thisMonth, until: now, calendar: calendar)
        XCTAssertEqual(
            csv,
            "day,machine,project,tool,cost_usd,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens\r\n"
                + "2026-10-27,Arch,api,Claude Code,0.2500,1,2,3,4\r\n"
                + "2026-10-27,MacBook,api,Claude Code,1.5000,1,2,3,4\r\n")
        XCTAssertEqual(UsageExport.csv(usage, range: .all, until: now, calendar: calendar).components(separatedBy: "\r\n").count, 5)
    }

    func testFieldsStayTextAndInOneColumn() {
        XCTAssertEqual(UsageExport.field("my, project"), "\"my, project\"")
        XCTAssertEqual(UsageExport.field("say \"hi\""), "\"say \"\"hi\"\"\"")
        XCTAssertEqual(UsageExport.field("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"")
        XCTAssertEqual(UsageExport.field("-rm"), "'-rm")
        XCTAssertEqual(UsageExport.field("plain"), "plain")
    }
}
