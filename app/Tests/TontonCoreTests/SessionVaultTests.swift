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
              "createdAt":"2026-10-25T10:00:00.000Z","lastSeen":null,"online":true}],
             "sessions":[{"id":"s1","machineId":"m1","status":"permission","agentOnline":true,"canChat":true,
              "info":"\(try sealed(SessionInfo(machine: "PC-Studio", platform: "win32", cwd: "C:\\\\code\\\\api", project: "api")))",
              "meta":"\(try sealed(SessionMeta(title: "Rate limit login", costUSD: 0.84, lastMessage: "Deploying")))",
              "statusDetail":"\(try sealed(StatusDetail(text: "Claude needs your permission to use Bash")))",
              "pendingPermissions":[{"requestId":"abcde","ts":"now","blob":"\(try sealed(PermissionDetail(toolName: "Bash", description: "Deploy", inputPreview: "{}")))"}],
              "startedAt":"2026-10-25T10:00:00.000Z","lastActivity":"2026-10-25T10:05:00Z"}]}
            """
        guard case .snapshot(let wireSessions, let wireMachines) = try JSONDecoder().decode(RelayMessage.self, from: Data(json.utf8)) else {
            return XCTFail("expected a snapshot")
        }
        let machines = vault.machines(wireMachines)
        XCTAssertEqual(machines.map(\.name), ["PC-Studio"])
        XCTAssertEqual(machines.first?.platform, "win32")

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

    func testPromptsAreSealedForTheAgent() throws {
        let blob = try vault.sealPrompt(text: "Ship it", images: [])
        XCTAssertEqual(try E2E.open(blob, as: PromptPayload.self, with: key).text, "Ship it")
    }
}
