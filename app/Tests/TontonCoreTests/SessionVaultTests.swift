import CryptoKit
import XCTest

@testable import TontonCore

final class SessionVaultTests: XCTestCase {
    private let key = SymmetricKey(size: .bits256)
    private var vault: SessionVault { SessionVault(key: key) }

    private func sealed<T: Encodable>(_ value: T) throws -> String { try E2E.seal(value, with: key) }

    func testDecodesARelaySnapshot() throws {
        let json = """
            {"t":"snapshot","machines":[{"id":"m1","name":"\(try sealed(MachineName(name: "PC-Studio", platform: "win32")))",
              "createdAt":"2026-10-25T10:00:00.000Z","lastSeen":null,"online":true,"agentVersion":"0.3.0"}],
             "sessions":[{"id":"s1","machineId":"m1","status":"permission","agentOnline":true,"canChat":true,
              "info":"\(try sealed(SessionInfo(machine: "PC-Studio", platform: "win32", cwd: "C:\\\\code\\\\api", project: "api")))",
              "meta":"\(try sealed(SessionMeta(title: "Rate limit login", costUSD: 0.84, lastMessage: "Deploying")))",
              "statusDetail":"\(try sealed(StatusDetail(text: "Claude needs your permission to use Bash")))",
              "pendingPermissions":[{"requestId":"abcde","ts":"now","blob":"\(try sealed(PermissionDetail(toolName: "Bash", description: "Deploy", inputPreview: "{}")))"}],
              "startedAt":"2026-10-25T10:00:00.000Z","lastActivity":"2026-10-25T10:05:00Z"}]}
            """
        let message = try JSONDecoder().decode(RelayMessage.self, from: Data(json.utf8))
        guard case .snapshot(let wireSessions, let wireMachines) = message else { return XCTFail("expected a snapshot") }
        let machines = vault.machines(wireMachines)
        XCTAssertEqual(machines.map(\.name), ["PC-Studio"])
        XCTAssertEqual(machines.first?.platform, "win32")
        XCTAssertEqual(machines.first?.agentVersion, "0.3.0")

        let session = vault.session(wireSessions[0], machines: machines)
        XCTAssertEqual(session.project, "api")
        XCTAssertEqual(session.title, "Rate limit login")
        XCTAssertEqual(session.costUSD, 0.84)
        XCTAssertEqual(session.displayStatusText, "Wants to use Bash")
        XCTAssertEqual(session.pendingPermissions.map(\.toolName), ["Bash"])
        XCTAssertGreaterThan(session.lastActivity, session.startedAt)
    }

    func testTheFiveHourLimitComesWithTheMeta() throws {
        let limit = WireUsageLimit(usedPercent: 83.5, resetsAt: "2026-10-20T12:00:00.000Z")
        let meta = SessionMeta(title: nil, costUSD: nil, lastMessage: nil, fiveHourLimit: limit)
        let older = SessionMeta(title: "From an older agent", costUSD: nil, lastMessage: nil)
        func session(_ meta: SessionMeta) throws -> SessionSummary {
            let wire = WireSession(
                id: "s1", machineId: "m1", status: .working, agentOnline: true, canChat: true, info: nil, meta: try sealed(meta),
                statusDetail: nil, pendingPermissions: [], startedAt: "x", lastActivity: "x")
            return vault.session(wire, machines: [])
        }
        XCTAssertEqual(
            try session(meta).fiveHourLimit, UsageLimit(usedPercent: 83.5, resetsAt: Date(timeIntervalSince1970: 1_792_497_600)))
        XCTAssertNil(try session(older).fiveHourLimit)
    }

    func testTheGaugeFollowsTheWindow() {
        let resetsAt = Date(timeIntervalSince1970: 1_792_497_600)
        let now = resetsAt.addingTimeInterval(-3600)
        XCTAssertEqual(UsageLimit(usedPercent: 79.9, resetsAt: resetsAt).level(at: now), .normal)
        XCTAssertEqual(UsageLimit(usedPercent: 80, resetsAt: resetsAt).level(at: now), .high)
        XCTAssertEqual(UsageLimit(usedPercent: 100, resetsAt: resetsAt).level(at: now), .reached)
        // Once the window resets, the reading says nothing about the new one.
        XCTAssertNil(UsageLimit(usedPercent: 100, resetsAt: resetsAt).level(at: resetsAt))

        let expired = UsageLimit(usedPercent: 100, resetsAt: now.addingTimeInterval(-60))
        let low = UsageLimit(usedPercent: 12, resetsAt: resetsAt)
        let high = UsageLimit(usedPercent: 91, resetsAt: resetsAt)
        XCTAssertEqual(UsageLimit.fullest([low, nil, expired, high], at: now), high)
        XCTAssertNil(UsageLimit.fullest([nil, expired], at: now))
    }

    func testTheCountdownFollowsTheWindowThatStopsTheSession() {
        let now = Date(timeIntervalSince1970: 1_792_497_600)
        func session(fiveHour: Double?, sevenDay: Double?) -> SessionSummary {
            SessionSummary(
                id: "s1", machineId: "m1", machine: "PC", platform: nil, cwd: "/x", project: "x", title: nil, status: .error,
                statusText: "rate_limit", agentOnline: true, canChat: true, pendingPermissions: [], costUSD: nil, startedAt: now,
                lastActivity: now, lastMessage: nil,
                fiveHourLimit: fiveHour.map { UsageLimit(usedPercent: $0, resetsAt: now.addingTimeInterval(3600)) },
                sevenDayLimit: sevenDay.map { UsageLimit(usedPercent: $0, resetsAt: now.addingTimeInterval(3 * 86400)) })
        }
        XCTAssertNil(session(fiveHour: 40, sevenDay: 70).limitToWatch(at: now))
        XCTAssertEqual(session(fiveHour: 85, sevenDay: 92).limitToWatch(at: now)?.usedPercent, 92)
        XCTAssertEqual(session(fiveHour: 100, sevenDay: 92).limitToWatch(at: now)?.usedPercent, 100)
        // Stopped by both: free again only once the week resets.
        XCTAssertEqual(session(fiveHour: 100, sevenDay: 100).limitToWatch(at: now)?.resetsAt, now.addingTimeInterval(3 * 86400))
        XCTAssertNil(session(fiveHour: 100, sevenDay: nil).limitToWatch(at: now.addingTimeInterval(3600)))
        XCTAssertEqual(session(fiveHour: 100, sevenDay: nil).displayStatusText, "Usage limit reached")

        let stopped = UsageLimit(usedPercent: 100, resetsAt: now.addingTimeInterval(7200))
        let close = UsageLimit(usedPercent: 85, resetsAt: now.addingTimeInterval(600))
        XCTAssertEqual(UsageLimit.soonest([close, nil, stopped], at: now), stopped)
        XCTAssertEqual(UsageLimit.soonest([close, UsageLimit(usedPercent: 90, resetsAt: now.addingTimeInterval(900))], at: now), close)
        XCTAssertNil(UsageLimit.soonest([nil], at: now))
    }

    func testStoppedSessionsAreFreedAtTheirReset() {
        let now = Date(timeIntervalSince1970: 1_792_497_600)
        let reset = now.addingTimeInterval(1800)
        func session(_ id: String, _ status: SessionStatus = .error, used: Double = 100, resetsAt: Date) -> SessionSummary {
            SessionSummary(
                id: id, machineId: "m1", machine: "PC", platform: nil, cwd: "/x", project: id, title: nil, status: status,
                statusText: nil, agentOnline: true, canChat: true, pendingPermissions: [], costUSD: nil, startedAt: now,
                lastActivity: now, lastMessage: nil, fiveHourLimit: UsageLimit(usedPercent: used, resetsAt: resetsAt))
        }
        let sessions = [
            session("api", resetsAt: reset), session("web", resetsAt: reset), session("close", used: 90, resetsAt: reset),
            session("ended", .ended, resetsAt: reset), session("later", resetsAt: reset.addingTimeInterval(600)),
        ]
        XCTAssertEqual(sessions[0].stoppedUntil(at: now), reset)
        XCTAssertNil(sessions[2].stoppedUntil(at: now))
        XCTAssertEqual(LimitResets.upcoming(sessions, at: now), [reset, reset.addingTimeInterval(600)])
        XCTAssertEqual(LimitResets.lifted(sessions, at: reset).map(\.id), ["api", "web"])
        XCTAssertEqual(LimitResets.upcoming(sessions, at: reset.addingTimeInterval(601)), [])

        // Only the sessions the user asked for get `continue`, and only if they still take messages.
        let readOnly = SessionSummary(
            id: "read-only", machineId: "m1", machine: "PC", platform: nil, cwd: "/x", project: "x", title: nil, status: .error,
            statusText: nil, agentOnline: true, canChat: false, pendingPermissions: [], costUSD: nil, startedAt: now,
            lastActivity: now, lastMessage: nil)
        XCTAssertEqual(LimitResets.toContinue(sessions + [readOnly], optedIn: ["web", "ended", "read-only"]), ["web"])
    }

    func testTokensComeWithTheMetaAndReadShort() throws {
        let tokens = TokenCounts(input: 10, output: 48_200, cacheRead: 1_200_000, cacheWrite: 3_400)
        let meta = SessionMeta(title: nil, costUSD: 1.5, lastMessage: nil, tokens: tokens)
        let wire = WireSession(
            id: "s1", machineId: "m1", status: .working, agentOnline: true, canChat: true, info: nil, meta: try sealed(meta),
            statusDetail: nil, pendingPermissions: [], startedAt: "x", lastActivity: "x")
        XCTAssertEqual(vault.session(wire, machines: []).tokens, tokens)
        XCTAssertEqual(tokens.allInput, 1_203_410)
        XCTAssertEqual(TokenCounts.short(950), "950")
        XCTAssertEqual(TokenCounts.short(4_200), "4.2k")
        XCTAssertEqual(TokenCounts.short(5_000), "5k")
        XCTAssertEqual(TokenCounts.short(48_200), "48k")
        XCTAssertEqual(TokenCounts.short(1_203_410), "1.2M")
    }

    func testTimeLeftReadsLikeTheNotch() {
        let now = Date(timeIntervalSince1970: 1_792_497_600)
        func left(_ seconds: TimeInterval) -> String { UsageLimit(usedPercent: 90, resetsAt: now + seconds).timeLeft(at: now) }
        XCTAssertEqual(left(102 * 60), "1 h 42")
        XCTAssertEqual(left(65 * 60), "1 h 05")
        XCTAssertEqual(left(42 * 60 - 30), "42 min")
        XCTAssertEqual(left(10), "1 min")
        XCTAssertEqual(left(2 * 86400 + 5 * 3600), "2 d 5 h")
        XCTAssertEqual(left(3 * 86400), "3 d")
    }

    func testUnreadableFieldsDegradeToPlaceholders() throws {
        let foreign = try E2E.seal(SessionInfo(machine: "x", platform: nil, cwd: "x", project: "x"), with: SymmetricKey(size: .bits256))
        let json = """
            {"t":"session","session":{"id":"s1","machineId":"m1","status":"working","agentOnline":true,"canChat":false,
              "info":"\(foreign)","meta":null,"statusDetail":null,"pendingPermissions":[],"startedAt":"x","lastActivity":"x"}}
            """
        guard case .session(let wire) = try JSONDecoder().decode(RelayMessage.self, from: Data(json.utf8)) else { return XCTFail() }
        let session = vault.session(wire, machines: [])
        XCTAssertEqual(session.project, "Encrypted session")
        XCTAssertEqual(session.machine, "Unknown machine")
    }

    func testDecodesAgentUpdateResults() throws {
        let failure = """
            {"t":"agent_update","machineId":"m1","ok":false,"detail":"\(try sealed(StatusDetail(text: "download failed (HTTP 404)")))"}
            """
        guard case .agentUpdate("m1", false, nil, let detail) = try JSONDecoder().decode(RelayMessage.self, from: Data(failure.utf8)) else {
            return XCTFail("expected an agent update")
        }
        XCTAssertEqual(vault.detailText(detail), "download failed (HTTP 404)")

        let offline = #"{"t":"agent_update","machineId":"m1","ok":false,"reason":"offline"}"#
        guard case .agentUpdate(_, false, "offline", nil) = try JSONDecoder().decode(RelayMessage.self, from: Data(offline.utf8)) else {
            return XCTFail("expected an offline machine")
        }
    }

    func testMachinesFromOlderRelaysHaveNoVersion() throws {
        let json = #"{"t":"machines","machines":[{"id":"m1","name":"x","createdAt":"x","lastSeen":null,"online":false}]}"#
        guard case .machines(let wire) = try JSONDecoder().decode(RelayMessage.self, from: Data(json.utf8)) else {
            return XCTFail("expected machines")
        }
        XCTAssertNil(vault.machines(wire)[0].agentVersion)
        XCTAssertNil(vault.machines(wire)[0].agentUpdate(to: "0.4.0"))
    }

    func testInstallCommandsCarryTheToken() {
        let releases = "https://github.com/matteoepitech/tonton-claude/releases/latest/download"
        XCTAssertEqual(InstallCommand.windows(token: "tonton_x"), "$env:TONTON_TOKEN='tonton_x'; irm \(releases)/install.ps1 | iex")
        XCTAssertEqual(InstallCommand.unix(token: "tonton_x"), "curl -fsSL \(releases)/install.sh | TONTON_TOKEN='tonton_x' sh")
        XCTAssertEqual(InstallCommand.windows(), "irm \(releases)/install.ps1 | iex")
    }

    func testTheMachineTokenHoldsWhatAnAgentNeeds() throws {
        let account = Account(relay: "https://relay.example.com", accountId: "abcdefghijkl", token: "ta_x", key: E2E.newKey())
        XCTAssertNil(account.machineToken)
        let token = try XCTUnwrap(account.with(joinSecret: "s").machineToken)
        XCTAssertTrue(token.hasPrefix("tonton_"))
        let json = try XCTUnwrap(Data(base64URLEncoded: String(token.dropFirst("tonton_".count))))
        XCTAssertEqual(
            try JSONDecoder().decode([String: String].self, from: json),
            ["relay": "https://relay.example.com", "account": "abcdefghijkl", "secret": "s", "key": account.key])
    }

    func testRecoveryKeysKeepTheJoinSecret() throws {
        let account = Account(relay: "https://r", accountId: "a", token: "t", key: E2E.newKey(), joinSecret: "s")
        XCTAssertEqual(Account(recoveryKey: account.recoveryKey), account)
    }

    func testAgentUpdateKind() {
        func machine(_ version: String?, online: Bool = true) -> MachineInfo {
            MachineInfo(id: "m1", name: "PC", platform: nil, createdAt: .now, lastSeen: nil, online: online, agentVersion: version)
        }
        XCTAssertEqual(machine("0.4.0").agentUpdate(to: "0.10.0"), .oneClick)
        XCTAssertEqual(machine("0.4.0", online: false).agentUpdate(to: "0.5.0"), .oneClick)
        XCTAssertNil(machine("0.10.0").agentUpdate(to: "0.10.0"))
        XCTAssertNil(machine("0.11.0").agentUpdate(to: "0.10.0"))
        XCTAssertEqual(machine(nil).agentUpdate(to: "0.4.0"), .manual)
        XCTAssertNil(machine(nil, online: false).agentUpdate(to: "0.4.0"))
    }

    func testUpdateOrdersAreSealedWithTheirDate() throws {
        let date = Date(timeIntervalSince1970: 1_800_000_000)
        let order = try E2E.open(try vault.sealUpdateOrder(version: "0.4.0", issuedAt: date), as: UpdateOrder.self, with: key)
        XCTAssertEqual(order.version, "0.4.0")
        XCTAssertEqual(order.issuedAt, "2027-01-15T08:00:00Z")
    }

    func testPromptsAreSealedForTheAgent() throws {
        let blob = try vault.sealPrompt(text: "Ship it", images: [])
        XCTAssertEqual(try E2E.open(blob, as: PromptPayload.self, with: key).text, "Ship it")
    }
}
