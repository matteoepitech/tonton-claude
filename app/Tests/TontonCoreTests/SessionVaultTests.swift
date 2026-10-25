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
              "createdAt":"2026-10-25T10:00:00.000Z","lastSeen":null,"online":true,"agentVersion":"0.3.0"}],"latestAgentVersion":"0.4.0",
             "sessions":[{"id":"s1","machineId":"m1","status":"permission","agentOnline":true,"canChat":true,
              "info":"\(try sealed(SessionInfo(machine: "PC-Studio", platform: "win32", cwd: "C:\\\\code\\\\api", project: "api")))",
              "meta":"\(try sealed(SessionMeta(title: "Rate limit login", costUSD: 0.84, lastMessage: "Deploying")))",
              "statusDetail":"\(try sealed(StatusDetail(text: "Claude needs your permission to use Bash")))",
              "pendingPermissions":[{"requestId":"abcde","ts":"now","blob":"\(try sealed(PermissionDetail(toolName: "Bash", description: "Deploy", inputPreview: "{}")))"}],
              "startedAt":"2026-10-25T10:00:00.000Z","lastActivity":"2026-10-25T10:05:00Z"}]}
            """
        let message = try JSONDecoder().decode(RelayMessage.self, from: Data(json.utf8))
        guard case .snapshot(let wireSessions, let wireMachines, let latest) = message else { return XCTFail("expected a snapshot") }
        let machines = vault.machines(wireMachines)
        XCTAssertEqual(machines.map(\.name), ["PC-Studio"])
        XCTAssertEqual(machines.first?.platform, "win32")
        XCTAssertEqual(machines.first?.agentVersion, "0.3.0")
        XCTAssertEqual(latest, "0.4.0")

        let session = vault.session(wireSessions[0], machines: machines)
        XCTAssertEqual(session.project, "api")
        XCTAssertEqual(session.title, "Rate limit login")
        XCTAssertEqual(session.costUSD, 0.84)
        XCTAssertEqual(session.displayStatusText, "Wants to use Bash")
        XCTAssertEqual(session.pendingPermissions.map(\.toolName), ["Bash"])
        XCTAssertGreaterThan(session.lastActivity, session.startedAt)
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

    func testOlderRelaysOfferNoUpdate() throws {
        let json = #"{"t":"machines","machines":[{"id":"m1","name":"x","createdAt":"x","lastSeen":null,"online":true}]}"#
        guard case .machines(let wire, let latest) = try JSONDecoder().decode(RelayMessage.self, from: Data(json.utf8)) else {
            return XCTFail("expected machines")
        }
        XCTAssertNil(latest)
        XCTAssertNil(vault.machines(wire)[0].agentUpdate(to: latest))
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
