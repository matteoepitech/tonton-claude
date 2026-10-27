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

    func testTheDailyBudgetAlertsOnceADay() {
        var history = UsageHistory()
        history.record([session("s1", cost: 12), session("s2", machine: "Mac", cost: 9)], at: now, calendar: calendar)
        XCTAssertEqual(history.spent(on: now, calendar: calendar), 21)
        XCTAssertEqual(history.spent(on: now.addingTimeInterval(86400), calendar: calendar), 0)

        let today = UsageHistory.day(now, calendar: calendar)
        XCTAssertTrue(DailyBudget.shouldAlert(spent: 21, budget: 20, lastAlertDay: "2026-10-25", today: today))
        XCTAssertFalse(DailyBudget.shouldAlert(spent: 21, budget: 20, lastAlertDay: today, today: today))
        XCTAssertFalse(DailyBudget.shouldAlert(spent: 19.99, budget: 20, lastAlertDay: "", today: today))
        XCTAssertFalse(DailyBudget.shouldAlert(spent: 500, budget: 0, lastAlertDay: "", today: today))
    }

    func testTheMonthCountsItsOwnDaysOnly() {
        // 31 October 23:30 and 1 November 00:30 in Paris: two months, an hour apart.
        let october = Date(timeIntervalSince1970: 1_793_485_800)
        let november = october.addingTimeInterval(3600)
        var history = UsageHistory()
        history.record(
            [session("s1", cost: 40, startedAt: october), session("s2", cost: 5, startedAt: now)], at: october, calendar: calendar)
        history.record(
            [session("s1", cost: 40, startedAt: october), session("s3", project: "web", cost: 7, startedAt: november)], at: november,
            calendar: calendar)
        XCTAssertEqual(UsageHistory.month(october, calendar: calendar), "2026-10")
        XCTAssertEqual(UsageHistory.month(november, calendar: calendar), "2026-11")
        XCTAssertEqual(history.spentInMonth(of: october, calendar: calendar), 45, accuracy: 0.0001)
        XCTAssertEqual(history.spentInMonth(of: november, calendar: calendar), 7, accuracy: 0.0001)
    }

    func testTheMonthlyBudgetAlertsOnceAMonthAndAgainWhenRaised() {
        XCTAssertTrue(MonthlyBudget.shouldAlert(spent: 120, budget: 100, lastAlert: "", month: "2026-10"))
        let mark = MonthlyBudget.mark(month: "2026-10", budget: 100)
        XCTAssertEqual(mark, "2026-10@100")
        // Once a month.
        XCTAssertFalse(MonthlyBudget.shouldAlert(spent: 180, budget: 100, lastAlert: mark, month: "2026-10"))
        XCTAssertTrue(MonthlyBudget.shouldAlert(spent: 120, budget: 100, lastAlert: mark, month: "2026-11"))
        // Raised after the alert: armed again for the new amount. Lowered: the month was already flagged.
        XCTAssertFalse(MonthlyBudget.shouldAlert(spent: 150, budget: 200, lastAlert: mark, month: "2026-10"))
        XCTAssertTrue(MonthlyBudget.shouldAlert(spent: 210, budget: 200, lastAlert: mark, month: "2026-10"))
        XCTAssertFalse(MonthlyBudget.shouldAlert(spent: 120, budget: 50, lastAlert: mark, month: "2026-10"))
        // Under it, or no budget.
        XCTAssertFalse(MonthlyBudget.shouldAlert(spent: 99.99, budget: 100, lastAlert: "", month: "2026-10"))
        XCTAssertFalse(MonthlyBudget.shouldAlert(spent: 5000, budget: 0, lastAlert: "", month: "2026-10"))
        // An unreadable mark never silences it.
        XCTAssertTrue(MonthlyBudget.shouldAlert(spent: 120, budget: 100, lastAlert: "garbage", month: "2026-10"))
    }
}
