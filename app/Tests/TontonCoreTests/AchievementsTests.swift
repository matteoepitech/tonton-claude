import XCTest

@testable import TontonCore

final class AchievementsTests: XCTestCase {
    /// 08:00 UTC.
    private let noon = Date(timeIntervalSince1970: 1_800_000_000)
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private func session(_ id: String, on machine: String = "m", _ status: SessionStatus = .working, started: Date? = nil) -> SessionSummary
    {
        SessionSummary(
            id: id, machineId: machine, machine: machine, platform: nil, cwd: "/", project: id, title: nil, status: status,
            statusText: nil, agentOnline: true, canChat: true, pendingPermissions: [], costUSD: nil, startedAt: started ?? noon,
            lastActivity: noon, lastMessage: nil)
    }

    func testEachAchievementUnlocksOnce() {
        var progress = AchievementProgress()
        XCTAssertEqual(progress.sessionsChanged([session("a", .idle)], now: noon, calendar: calendar), [.firstSession])
        XCTAssertEqual(progress.sessionsChanged([session("a", .idle)], now: noon, calendar: calendar), [])
    }

    func testApprovalsAndNotchMessagesCount() {
        var progress = AchievementProgress()
        XCTAssertEqual((1...9).flatMap { _ in progress.approved() }, [])
        XCTAssertEqual(progress.approved(), [.approved10])
        XCTAssertEqual((11...100).flatMap { _ in progress.approved() }, [.approved100])
        XCTAssertEqual((1...50).flatMap { _ in progress.sentFromNotch() }, [.remoteControl])
    }

    func testWhatIsGoingOnAtOnce() {
        var progress = AchievementProgress()
        let sessions = (1...5).map { session("s\($0)", on: "m\($0 % 3)") }
        XCTAssertEqual(progress.sessionsChanged(sessions, now: noon, calendar: calendar), [.firstSession, .threeMachines, .fiveAtOnce])
    }

    func testMarathonDeepWorkAndNightOwl() throws {
        var progress = AchievementProgress()
        _ = progress.sessionsChanged([session("a", started: noon - 7 * 3600)], now: noon, calendar: calendar)
        XCTAssertTrue(progress.unlocked.contains(.marathon))
        XCTAssertFalse(progress.unlocked.contains(.deepWork))
        XCTAssertEqual(
            progress.sessionsChanged([session("a", started: noon - 7 * 3600)], now: noon + 31 * 60, calendar: calendar), [.deepWork])
        let threeAM = try XCTUnwrap(calendar.date(from: DateComponents(year: 2027, month: 1, day: 16, hour: 3, minute: 20)))
        XCTAssertEqual(progress.sessionsChanged([session("b")], now: threeAM, calendar: calendar), [.nightOwl])
    }

    func testAShortTurnIsNotDeepWorkAndProgressIsSaved() throws {
        var progress = AchievementProgress()
        _ = progress.sessionsChanged([session("a")], now: noon, calendar: calendar)
        _ = progress.sessionsChanged([session("a", .idle)], now: noon + 20 * 60, calendar: calendar)
        XCTAssertEqual(progress.sessionsChanged([session("a")], now: noon + 40 * 60, calendar: calendar), [])
        _ = progress.approved()
        let saved = try JSONDecoder().decode(AchievementProgress.self, from: JSONEncoder().encode(progress))
        XCTAssertEqual(saved.unlocked, progress.unlocked)
        XCTAssertEqual(saved.approvals, 1)
    }
}
