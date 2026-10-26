import XCTest

@testable import TontonCore

final class UsageHistoryTests: XCTestCase {
    private var calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Paris") ?? .current
        return calendar
    }()
    /// Monday 26 October 2026, 10:00 in Paris.
    private let now = Date(timeIntervalSince1970: 1_793_005_200)

    private func session(
        _ id: String, machine: String = "PC", project: String = "api", cost: Double?, output: Int = 0, startedAt: Date? = nil
    ) -> SessionSummary {
        SessionSummary(
            id: id, machineId: "m", machine: machine, platform: nil, cwd: "/x", project: project, title: nil, status: .working,
            statusText: nil, agentOnline: true, canChat: true, pendingPermissions: [], costUSD: cost, startedAt: startedAt ?? now,
            lastActivity: now, lastMessage: nil, tokens: TokenCounts(output: output))
    }

    func testEachReadingAddsWhatGrewToItsDay() {
        var history = UsageHistory()
        history.record([session("s1", cost: 1.0, output: 100)], at: now, calendar: calendar)
        history.record([session("s1", cost: 1.5, output: 250)], at: now.addingTimeInterval(60), calendar: calendar)
        history.record([session("s1", cost: 1.5, output: 250)], at: now.addingTimeInterval(120), calendar: calendar)
        XCTAssertEqual(history.entries.count, 1)
        XCTAssertEqual(history.entries[0].day, "2026-10-26")
        XCTAssertEqual(history.entries[0].costUSD, 1.5, accuracy: 0.0001)
        XCTAssertEqual(history.entries[0].tokens.output, 250)

        // The next day, only what was spent since goes there.
        let tomorrow = now.addingTimeInterval(86400)
        history.record([session("s1", cost: 2.0, output: 300)], at: tomorrow, calendar: calendar)
        XCTAssertEqual(history.entries.map(\.day), ["2026-10-26", "2026-10-27"])
        XCTAssertEqual(history.entries[1].costUSD, 0.5, accuracy: 0.0001)
    }

    func testASessionSeenForTheFirstTimeCountsOnTheDayItStarted() {
        var history = UsageHistory()
        let yesterday = now.addingTimeInterval(-86400)
        history.record([session("s1", cost: 3, startedAt: yesterday)], at: now, calendar: calendar)
        XCTAssertEqual(history.entries.map(\.day), ["2026-10-25"])
    }

    func testTotalsThatStartOverBecomeTheNewBaseline() {
        var history = UsageHistory()
        history.record([session("s1", cost: 5, output: 500)], at: now, calendar: calendar)
        history.record([session("s1", cost: 5, output: 20)], at: now.addingTimeInterval(60), calendar: calendar)
        history.record([session("s1", cost: 5, output: 70)], at: now.addingTimeInterval(120), calendar: calendar)
        XCTAssertEqual(history.entries[0].tokens.output, 550)
    }

    func testDaysMachinesAndProjects() {
        var history = UsageHistory()
        history.record(
            [
                session("s1", machine: "PC", project: "api", cost: 4), session("s2", machine: "Mac", project: "web", cost: 1),
                session("s3", machine: "PC", project: "web", cost: 2),
                session("old", cost: 9, startedAt: now.addingTimeInterval(-10 * 86400)),
            ], at: now, calendar: calendar)
        let daily = history.daily(7, until: now, calendar: calendar)
        XCTAssertEqual(daily.count, 7)
        XCTAssertEqual(daily.last?.entries.count, 3)
        XCTAssertTrue(daily.dropLast().allSatisfy(\.entries.isEmpty))
        XCTAssertEqual(history.totals(by: \.machine, days: 7, until: now, calendar: calendar).map(\.name), ["PC", "Mac"])
        XCTAssertEqual(history.totals(by: \.machine, days: 7, until: now, calendar: calendar).first?.costUSD, 6)
        XCTAssertEqual(history.totals(by: \.project, days: 7, until: now, calendar: calendar).map(\.name), ["api", "web"])
        XCTAssertEqual(history.totals(by: \.project, days: 30, until: now, calendar: calendar).first?.costUSD, 13)
    }

    func testOldDaysAndForgottenSessionsArePruned() throws {
        var history = UsageHistory()
        history.record([session("s1", cost: 1, startedAt: now.addingTimeInterval(-500 * 86400))], at: now, calendar: calendar)
        XCTAssertEqual(history.entries, [])
        history.record([session("s2", cost: 1)], at: now, calendar: calendar)
        history.record([], at: now.addingTimeInterval(31 * 86400), calendar: calendar)
        XCTAssertNil(history.readings["s2"])
        XCTAssertEqual(history.entries.count, 1)
        XCTAssertEqual(try JSONDecoder().decode(UsageHistory.self, from: try JSONEncoder().encode(history)), history)
    }
}
