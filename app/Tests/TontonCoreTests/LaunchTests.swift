import CryptoKit
import XCTest

@testable import TontonCore

final class LaunchTests: XCTestCase {
    private let key = SymmetricKey(size: .bits256)
    private var vault: SessionVault { SessionVault(key: key) }
    private let now = Date(timeIntervalSince1970: 1_793_005_200)

    private func session(_ id: String, machineId: String = "m1", cwd: String, minutesAgo: Double) -> SessionSummary {
        SessionSummary(
            id: id, machineId: machineId, machine: "PC", platform: nil, cwd: cwd, project: "x", title: nil, status: .idle,
            statusText: nil, agentOnline: true, canChat: true, pendingPermissions: [], costUSD: nil, startedAt: now,
            lastActivity: now.addingTimeInterval(-minutesAgo * 60), lastMessage: nil)
    }

    func testLaunchIdsSuitTheRelay() {
        let id = SessionLaunch.newId()
        XCTAssertNotNil(id.range(of: "^[a-z0-9]{8,32}$", options: .regularExpression))
        XCTAssertNotEqual(id, SessionLaunch.newId())
    }

    private func detail(
        _ state: String, launch: String = "l1", machine: String = "m1", text: String? = nil, question: String? = nil,
        sessionId: String? = nil
    ) -> StartDetail {
        StartDetail(launchId: launch, machineId: machine, state: state, text: text, question: question, sessionId: sessionId)
    }

    func testFollowsWhatTheMachineReports() {
        let launch = SessionLaunch(id: "l1", machineId: "m1", cwd: "~/code/api")
        XCTAssertEqual(launch.state, .sending)
        XCTAssertTrue(launch.isRunning)

        let trust = "Claude Code asks whether you trust the files in this folder.\n\n❯ 1. Yes\n  2. No"
        let asking = launch.reported("asking", reason: nil, detail: detail("asking", text: trust, question: "q2"), machine: "PC")
        XCTAssertEqual(asking.state, .asking)
        XCTAssertEqual(asking.questionId, "q2")
        XCTAssertEqual(asking.question, "Claude Code asks whether you trust the files in this folder.")
        XCTAssertEqual(asking.screen, "❯ 1. Yes\n  2. No")
        // The margin Claude Code's box puts before every line goes, the indentation inside it stays.
        let boxed = launch.reported(
            "asking", reason: nil,
            detail: detail("asking", text: "Q\n\n   Quick safety check   \n\n   ❯ 1. Yes\n     2. No", question: "q1"),
            machine: "PC")
        XCTAssertEqual(boxed.screen, "Quick safety check\n\n❯ 1. Yes\n  2. No")

        let answered = asking.answered("q2")
        XCTAssertEqual(answered.state, .starting)
        XCTAssertNil(answered.questionId)
        let started = answered.reported("started", reason: nil, detail: detail("started", text: "Running", sessionId: "s9"), machine: "PC")
        XCTAssertEqual(started.state, .started)
        XCTAssertNil(started.questionId)
        XCTAssertEqual(started.sessionId, "s9")
        XCTAssertFalse(started.isRunning)
        XCTAssertNil(started.question)
    }

    func testOnlyTheSealedDetailCounts() {
        let launch = SessionLaunch(id: "l1", machineId: "m1", cwd: "/srv")
        let asking = detail("asking", text: "Load the channel?", question: "q1")
        // The relay changes the plain state, replays a report of another start or machine, or drops the detail.
        XCTAssertEqual(launch.reported("failed", reason: nil, detail: asking, machine: "PC"), launch)
        XCTAssertEqual(
            launch.reported("asking", reason: nil, detail: detail("asking", launch: "l0", question: "q1"), machine: "PC"), launch)
        XCTAssertEqual(
            launch.reported("asking", reason: nil, detail: detail("asking", machine: "m2", question: "q1"), machine: "PC"), launch)
        XCTAssertEqual(launch.reported("started", reason: nil, detail: nil, machine: "PC"), launch)
        // A question without an id can't be answered, and one already answered can't be asked again.
        XCTAssertEqual(launch.reported("asking", reason: nil, detail: detail("asking", text: "?"), machine: "PC"), launch)
        let answered = launch.reported("asking", reason: nil, detail: asking, machine: "PC").answered("q1")
        XCTAssertEqual(answered.reported("asking", reason: nil, detail: asking, machine: "PC"), answered)
        // Unknown states, from a newer agent, change nothing; the app's own state never comes from the machine.
        XCTAssertEqual(launch.reported("paused", reason: nil, detail: detail("paused"), machine: "PC"), launch)
        XCTAssertEqual(launch.reported("sending", reason: nil, detail: detail("sending"), machine: "PC"), launch)
    }

    func testFailures() {
        let launch = SessionLaunch(id: "l1", machineId: "m1", cwd: "/srv")
        let offline = launch.reported("failed", reason: "offline", detail: nil, machine: "PC")
        XCTAssertEqual(offline.state, .failed)
        XCTAssertEqual(offline.headline, "PC is offline. Check that it is on and that the Tonton Claude agent runs there.")
        XCTAssertNil(offline.screen)

        let stopped = launch.reported(
            "failed", reason: nil, detail: detail("failed", text: "claude stopped before it was ready.\n\nzsh: command not found: claude"),
            machine: "PC")
        XCTAssertEqual(stopped.headline, "claude stopped before it was ready.")
        XCTAssertEqual(stopped.screen, "zsh: command not found: claude")
        XCTAssertEqual(launch.failed("No answer").text, "No answer")
    }

    func testRecentFoldersPerMachine() {
        let sessions = [
            session("a", cwd: "/code/web", minutesAgo: 30), session("b", cwd: "/code/api/", minutesAgo: 5),
            session("c", machineId: "m2", cwd: "/elsewhere", minutesAgo: 1), session("d", cwd: "", minutesAgo: 2),
        ]
        XCTAssertEqual(
            RecentFolders.list(started: ["~/notes", "/code/web"], sessions: sessions, machineId: "m1"),
            ["~/notes", "/code/web", "/code/api"])
        XCTAssertEqual(RecentFolders.list(started: [], sessions: sessions, machineId: "m3"), [])

        var started: [String] = []
        for index in 0..<10 { started = RecentFolders.adding("/p\(index)", to: started) }
        started = RecentFolders.adding("/p5/", to: started)
        XCTAssertEqual(started.count, RecentFolders.limit)
        XCTAssertEqual(started.prefix(3), ["/p5", "/p9", "/p8"])
    }

    func testStartableFolders() {
        XCTAssertTrue(RecentFolders.isStartable("/srv/api"))
        XCTAssertTrue(RecentFolders.isStartable("~/code/api/"))
        XCTAssertTrue(RecentFolders.isStartable(" ~ "))
        XCTAssertFalse(RecentFolders.isStartable("code/api"))
        XCTAssertFalse(RecentFolders.isStartable("~other/api"))
        XCTAssertFalse(RecentFolders.isStartable(""))
        XCTAssertEqual(RecentFolders.normalized("/"), "/")
    }

    func testOrdersAndAnswersAreSealedForOneLaunchOnOneMachine() throws {
        let order = try E2E.open(
            try vault.sealStartOrder(launchId: "l1", machineId: "m1", cwd: "~/code", issuedAt: now), as: StartOrder.self, with: key)
        XCTAssertEqual(order.launchId, "l1")
        XCTAssertEqual(order.machineId, "m1")
        XCTAssertEqual(order.cwd, "~/code")
        XCTAssertEqual(order.issuedAt, "2026-10-26T09:00:00Z")

        let answer = try E2E.open(
            try vault.sealStartAnswer(launchId: "l1", machineId: "m1", question: "q2", confirm: true, issuedAt: now), as: StartAnswer.self,
            with: key)
        XCTAssertEqual(answer.launchId, "l1")
        XCTAssertEqual(answer.machineId, "m1")
        XCTAssertEqual(answer.question, "q2")
        XCTAssertTrue(answer.confirm)
    }

    func testDecodesSessionStarts() throws {
        let sealed = try E2E.seal(detail("asking", text: "Claude Code asks…", question: "q1"), with: key)
        let asking = #"{"t":"session_start","machineId":"m1","launchId":"l1","state":"asking","detail":"\#(sealed)"}"#
        guard case .sessionStart("m1", "l1", "asking", nil, let blob) = try JSONDecoder().decode(RelayMessage.self, from: Data(asking.utf8))
        else { return XCTFail("expected a question") }
        XCTAssertEqual(vault.startDetail(blob), detail("asking", text: "Claude Code asks…", question: "q1"))
        // The agent writes no `text` for a plain step.
        let json = String(decoding: try JSONEncoder().encode(detail("starting")), as: UTF8.self)
        XCTAssertFalse(json.contains("text"))

        let offline = #"{"t":"session_start","machineId":"m1","launchId":"l1","state":"failed","reason":"offline"}"#
        guard case .sessionStart(_, _, "failed", "offline", nil) = try JSONDecoder().decode(RelayMessage.self, from: Data(offline.utf8))
        else { return XCTFail("expected an offline machine") }
    }
}
