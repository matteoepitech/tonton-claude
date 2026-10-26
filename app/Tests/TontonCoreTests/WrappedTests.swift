import XCTest

@testable import TontonCore

final class WrappedTests: XCTestCase {
    private var calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Paris") ?? .current
        return calendar
    }()
    /// Monday 26 October 2026, 10:00 in Paris.
    private let now = Date(timeIntervalSince1970: 1_793_005_200)

    private func call(_ id: String, _ name: String, ts: String = "2026-10-26T08:00:00.000Z", toolUseId: String? = nil) -> Entry {
        Entry(id: id, ts: ts, kind: .tool, toolUseId: toolUseId ?? "toolu_\(id)", name: name)
    }

    func testTasksAddUpPerProjectAndSession() {
        var log = WrappedLog()
        log.worked(1800, session: "s1", project: "api", at: now, calendar: calendar)
        log.worked(1200, session: "s1", project: "api", at: now, calendar: calendar)
        log.worked(2400, session: "s2", project: "web", at: now, calendar: calendar)
        log.worked(600, session: "s3", project: "web", at: now, calendar: calendar)
        let recap = log.recap("2026-10")
        XCTAssertEqual(recap?.worked, 6000)
        // Both projects worked 50 minutes: the tie goes to the first name.
        XCTAssertEqual(recap?.topProject, WrappedLog.Ranked(name: "api", value: 3000))
        XCTAssertEqual(recap?.longestSession, WrappedLog.Ranked(name: "api", value: 3000))
    }

    func testToolCallsCountOnceWhateverCopyBringsThem() {
        var log = WrappedLog()
        XCTAssertTrue(log.count(["s1": [call("a", "Bash"), call("b", "Edit"), call("c", "Bash")]], calendar: calendar))
        // The transcript on this Mac and the relay's history give the same calls other entry ids.
        XCTAssertFalse(log.count(["s1": [call("local-a", "Bash", toolUseId: "toolu_a")]], calendar: calendar))
        log.count(
            ["s2": [call("d", "Read"), Entry(id: "e", ts: "2026-10-26T08:00:00Z", kind: .assistant, text: "hi")]], calendar: calendar)
        let recap = log.recap("2026-10")
        XCTAssertEqual(recap?.toolCalls, 4)
        XCTAssertEqual(recap?.topTool, WrappedLog.Ranked(name: "Bash", value: 2))
    }

    func testCallsCountInTheMonthClaudeMadeThem() {
        var log = WrappedLog()
        // 23:30 on 30 September in Paris, 21:30 in UTC.
        log.count(
            ["s1": [call("a", "Grep", ts: "2026-09-30T21:30:00Z"), call("b", "Grep", ts: "2026-09-30T22:30:00Z")]], calendar: calendar)
        XCTAssertEqual(log.recap("2026-09")?.toolCalls, 1)
        XCTAssertEqual(log.recap("2026-10")?.toolCalls, 1)
        XCTAssertEqual(log.recorded, ["2026-10", "2026-09"])
    }

    func testKeepsAYearAndAMonth() {
        var log = WrappedLog()
        for offset in 0..<16 {
            guard let date = calendar.date(byAdding: .month, value: -offset, to: now) else { return XCTFail() }
            log.worked(60, session: "s\(offset)", project: "api", at: date, calendar: calendar)
        }
        XCTAssertEqual(log.recorded.count, 13)
        XCTAssertEqual(log.recorded.first, "2026-10")
        XCTAssertEqual(log.recorded.last, "2025-10")
        XCTAssertNil(log.recap("2025-09"))
    }

    func testSurvivesASaveAndALoad() throws {
        var log = WrappedLog()
        log.worked(90, session: "s1", project: "api", at: now, calendar: calendar)
        log.count(["s1": [call("a", "Bash")]], calendar: calendar)
        let loaded = try JSONDecoder().decode(WrappedLog.self, from: JSONEncoder().encode(log))
        XCTAssertEqual(loaded, log)
        var again = loaded
        XCTAssertFalse(again.count(["s1": [call("a", "Bash")]], calendar: calendar))
    }

    func testTextsAndTheMonthsSpending() {
        XCTAssertEqual(WrappedLog.title("2026-10", locale: Locale(identifier: "en_US")), "October 2026")
        XCTAssertEqual(WrappedLog.duration(42 * 60), "42 min")
        XCTAssertEqual(WrappedLog.duration(12 * 3600 + 5 * 60), "12 h 05")
        var history = UsageHistory()
        let session = SessionSummary(
            id: "s1", machineId: "m", machine: "PC", platform: nil, cwd: "/x", project: "api", title: nil, status: .working,
            statusText: nil, agentOnline: true, canChat: true, pendingPermissions: [], costUSD: 2.5, startedAt: now,
            lastActivity: now, lastMessage: nil)
        history.record([session], at: now, calendar: calendar)
        XCTAssertEqual(history.spent(inMonth: "2026-10"), 2.5, accuracy: 0.0001)
        XCTAssertEqual(history.spent(inMonth: "2026-09"), 0)
    }
}
