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

    func testFollowsWhatTheMachineReports() {
        let launch = SessionLaunch(id: "l1", machineId: "m1", cwd: "~/code/api")
        XCTAssertEqual(launch.state, .sending)
        XCTAssertTrue(launch.isRunning)

        let asking = launch.reported(
            "asking",
            detail: StartDetail(text: "Claude Code asks whether you trust the files in this folder.\n\n❯ 1. Yes\n  2. No", step: 2),
            reason: nil, sessionId: nil, machine: "PC")
        XCTAssertEqual(asking.state, .asking)
        XCTAssertEqual(asking.step, 2)
        XCTAssertEqual(asking.question, "Claude Code asks whether you trust the files in this folder.")
        XCTAssertEqual(asking.screen, "❯ 1. Yes\n  2. No")
        // The margin Claude Code's box puts before every line goes, the indentation inside it stays.
        let boxed = launch.reported(
            "asking", detail: StartDetail(text: "Q\n\n   Quick safety check   \n\n   ❯ 1. Yes\n     2. No", step: 1), reason: nil,
            sessionId: nil, machine: "PC")
        XCTAssertEqual(boxed.screen, "Quick safety check\n\n❯ 1. Yes\n  2. No")

        let started = asking.reported("started", detail: StartDetail(text: "Running"), reason: nil, sessionId: "s9", machine: "PC")
        XCTAssertEqual(started.state, .started)
        XCTAssertNil(started.step)
        XCTAssertEqual(started.sessionId, "s9")
        XCTAssertFalse(started.isRunning)
        XCTAssertNil(started.question)

        // Unknown states, from a newer agent, change nothing; the app's own state never comes from the machine.
        XCTAssertEqual(launch.reported("paused", detail: nil, reason: nil, sessionId: nil, machine: "PC"), launch)
        XCTAssertEqual(asking.reported("sending", detail: nil, reason: nil, sessionId: nil, machine: "PC"), asking)
    }

    func testFailures() {
        let launch = SessionLaunch(id: "l1", machineId: "m1", cwd: "/srv")
        let offline = launch.reported("failed", detail: nil, reason: "offline", sessionId: nil, machine: "PC")
        XCTAssertEqual(offline.state, .failed)
        XCTAssertEqual(offline.headline, "PC is offline. Check that it is on and that the Tonton Claude agent runs there.")
        XCTAssertNil(offline.screen)

        let stopped = launch.reported(
            "failed", detail: StartDetail(text: "claude stopped before it was ready.\n\nzsh: command not found: claude"), reason: nil,
            sessionId: nil, machine: "PC")
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

    func testOrdersAndAnswersAreSealedForOneLaunch() throws {
        let order = try E2E.open(
            try vault.sealStartOrder(launchId: "l1", cwd: "~/code", issuedAt: now), as: StartOrder.self, with: key)
        XCTAssertEqual(order.launchId, "l1")
        XCTAssertEqual(order.cwd, "~/code")
        XCTAssertEqual(order.issuedAt, "2026-10-26T09:00:00Z")

        let answer = try E2E.open(
            try vault.sealStartAnswer(launchId: "l1", step: 2, confirm: true, issuedAt: now), as: StartAnswer.self, with: key)
        XCTAssertEqual(answer.launchId, "l1")
        XCTAssertEqual(answer.step, 2)
        XCTAssertTrue(answer.confirm)
    }

    func testDecodesSessionStarts() throws {
        let detail = try E2E.seal(StartDetail(text: "Claude Code asks…", step: 1), with: key)
        let asking = #"{"t":"session_start","machineId":"m1","launchId":"l1","state":"asking","detail":"\#(detail)"}"#
        guard
            case .sessionStart("m1", "l1", "asking", nil, let blob, nil) = try JSONDecoder().decode(
                RelayMessage.self, from: Data(asking.utf8))
        else { return XCTFail("expected a question") }
        XCTAssertEqual(vault.startDetail(blob), StartDetail(text: "Claude Code asks…", step: 1))

        let started = #"{"t":"session_start","machineId":"m1","launchId":"l1","state":"started","detail":null,"sessionId":"s1"}"#
        guard case .sessionStart(_, _, "started", nil, nil, "s1") = try JSONDecoder().decode(RelayMessage.self, from: Data(started.utf8))
        else { return XCTFail("expected a started session") }

        let offline = #"{"t":"session_start","machineId":"m1","launchId":"l1","state":"failed","reason":"offline"}"#
        guard
            case .sessionStart(_, _, "failed", "offline", nil, nil) = try JSONDecoder().decode(RelayMessage.self, from: Data(offline.utf8))
        else { return XCTFail("expected an offline machine") }
    }
}
