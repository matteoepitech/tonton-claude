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

    private func session(
        _ id: String, on machine: String = "m", _ status: SessionStatus = .working, started: Date? = nil, platform: String? = nil
    ) -> SessionSummary {
        SessionSummary(
            id: id, machineId: machine, machine: machine, platform: platform, cwd: "/", project: id, title: nil, status: status,
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

    func testSevenDaysInARow() {
        var progress = AchievementProgress()
        let day = { (offset: Int) in self.noon + Double(offset) * 86400 }
        for offset in 0..<6 {
            XCTAssertFalse(progress.sessionsChanged([session("a")], now: day(offset), calendar: calendar).contains(.weekStreak))
        }
        XCTAssertEqual(progress.goal(.weekStreak, now: day(5), calendar: calendar), AchievementGoal(6, of: 7))
        // The next morning, before Claude works, the streak still runs.
        XCTAssertEqual(progress.goal(.weekStreak, now: day(6), calendar: calendar), AchievementGoal(6, of: 7))
        XCTAssertEqual(progress.sessionsChanged([session("a")], now: day(6), calendar: calendar), [.weekStreak])
        XCTAssertNil(progress.goal(.weekStreak, now: day(6), calendar: calendar))
        // Idle sessions don't count, and a day off starts over.
        var other = AchievementProgress()
        _ = other.sessionsChanged([session("a")], now: day(0), calendar: calendar)
        _ = other.sessionsChanged([session("a", .idle)], now: day(1), calendar: calendar)
        XCTAssertEqual(other.goal(.weekStreak, now: day(2), calendar: calendar), AchievementGoal(0, of: 7))
        XCTAssertEqual(other.activeDays.count, 1)
    }

    func testSessionsOnEveryPlatform() {
        var progress = AchievementProgress()
        _ = progress.sessionsChanged([session("a", platform: "darwin"), session("b", platform: "freebsd")], now: noon, calendar: calendar)
        XCTAssertEqual(progress.goal(.everyPlatform), AchievementGoal(1, of: 3))
        _ = progress.sessionsChanged([session("c", .ended, platform: "win32")], now: noon, calendar: calendar)
        XCTAssertEqual(progress.sessionsChanged([session("d", .idle, platform: "linux")], now: noon, calendar: calendar), [.everyPlatform])
    }

    func testAThousandToolCallsCountedOnce() {
        var progress = AchievementProgress()
        let calls = { (range: Range<Int>) in
            range.map { Entry(id: "e\($0)", ts: "2026-10-26T10:00:00Z", kind: .tool, toolUseId: "toolu_\($0)", name: "Bash") }
        }
        let text = Entry(id: "t", ts: "2026-10-26T10:00:00Z", kind: .assistant, text: "hi")
        XCTAssertEqual(progress.count(["a": calls(0..<600) + [text]]), [])
        // The same calls come back from the relay and the transcript, after each launch.
        XCTAssertEqual(progress.count(["a": calls(0..<600), "b": calls(0..<600)]), [])
        XCTAssertEqual(progress.goal(.toolCalls1000), AchievementGoal(600, of: 1000))
        XCTAssertEqual(progress.count(["a": calls(0..<1000)]), [.toolCalls1000])
        XCTAssertEqual(progress.count(["a": calls(1000..<1500)]), [])
        XCTAssertEqual(progress.toolCalls, 1000)
    }

    func testProgressFromOlderAndNewerVersionsIsKept() throws {
        let older = #"{"unlocked":["firstSession","approved10"],"approvals":12,"notchMessages":3}"#
        let progress = try JSONDecoder().decode(AchievementProgress.self, from: Data(older.utf8))
        XCTAssertEqual(progress.unlocked, [.firstSession, .approved10])
        XCTAssertEqual(progress.goal(.approved100), AchievementGoal(12, of: 100))
        XCTAssertEqual(progress.goal(.remoteControl), AchievementGoal(3, of: 50))
        XCTAssertNil(progress.goal(.approved10))
        XCTAssertNil(progress.goal(.marathon))
        let newer = #"{"unlocked":["firstSession","somethingNew"],"approvals":1}"#
        XCTAssertEqual(try JSONDecoder().decode(AchievementProgress.self, from: Data(newer.utf8)).unlocked, [.firstSession])
    }
}
