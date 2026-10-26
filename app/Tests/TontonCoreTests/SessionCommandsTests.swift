import CryptoKit
import XCTest

@testable import TontonCore

final class SessionCommandsTests: XCTestCase {
    private let key = SymmetricKey(size: .bits256)
    private var vault: SessionVault { SessionVault(key: key) }
    private let now = Date(timeIntervalSince1970: 1_793_005_200)

    private func session(status: SessionStatus = .idle, terminal: Bool = true, canChat: Bool = true, online: Bool = true) -> SessionSummary
    {
        SessionSummary(
            id: "s1", machineId: "m1", machine: "PC", platform: nil, cwd: "/x", project: "x", title: nil, status: status, statusText: nil,
            agentOnline: online, canChat: canChat, pendingPermissions: [], costUSD: nil, startedAt: now, lastActivity: now,
            lastMessage: nil, terminal: terminal)
    }

    func testCommandsAreSealedLikeMessagesBoundToTheirSession() throws {
        let payload = try E2E.open(try vault.sealCommand(.clear, for: "s1", issuedAt: now), as: PromptPayload.self, with: key)
        XCTAssertEqual(payload.text, "")
        XCTAssertEqual(payload.command?.name, .clear)
        XCTAssertEqual(payload.command?.sessionId, "s1")
        XCTAssertEqual(payload.command?.issuedAt, "2026-10-26T09:00:00Z")
        // The agent takes the id as a file name.
        XCTAssertNotNil(payload.command?.id.range(of: "^[a-z0-9-]{8,64}$", options: .regularExpression))
        XCTAssertNotEqual(
            try E2E.open(try vault.sealCommand(.clear, for: "s1"), as: PromptPayload.self, with: key).command?.id, payload.command?.id)
        // Messages stay as they were for older agents.
        let message = String(decoding: try JSONEncoder().encode(PromptPayload(text: "hi", images: [])), as: UTF8.self)
        XCTAssertFalse(message.contains("command"))
    }

    func testOnlySessionsInTmuxWaitingAtTheirPromptTakeCommands() {
        XCTAssertTrue(session().acceptsCommands)
        XCTAssertTrue(session(status: .waiting).acceptsCommands)
        XCTAssertFalse(session(status: .working).acceptsCommands)
        XCTAssertFalse(session(status: .permission).acceptsCommands)
        XCTAssertFalse(session(terminal: false).acceptsCommands)
        XCTAssertFalse(session(canChat: false).acceptsCommands)
        XCTAssertFalse(session(online: false).acceptsCommands)
        XCTAssertTrue(SessionCommandName.clear.needsConfirmation)
        XCTAssertFalse(SessionCommandName.compact.needsConfirmation)
    }

    func testInterruptingIsForAWorkingSessionWhoseAgentSaysItCan() {
        let older = session(status: .working)
        XCTAssertEqual(older.commands, [.compact, .clear])
        XCTAssertFalse(older.accepts(.interrupt))
        let working = SessionSummary(
            id: "s1", machineId: "m1", machine: "PC", platform: nil, cwd: "/x", project: "x", title: nil, status: .working, statusText: nil,
            agentOnline: true, canChat: true, pendingPermissions: [], costUSD: nil, startedAt: now, lastActivity: now, lastMessage: nil,
            terminal: false, tool: "opencode", commands: [.compact, .interrupt])
        XCTAssertTrue(working.accepts(.interrupt))
        XCTAssertFalse(working.accepts(.compact))
        XCTAssertFalse(working.accepts(.clear))
        XCTAssertEqual(working.menuCommands, [.compact])
    }

    func testTheAgentSaysWhetherTheSessionRunsInTmux() throws {
        func wire(_ meta: SessionMeta) throws -> WireSession {
            let json = """
                {"id":"s1","machineId":"m1","status":"idle","agentOnline":true,"canChat":true,"meta":"\(try E2E.seal(meta, with: key))",
                 "pendingPermissions":[],"startedAt":"2026-10-25T10:00:00Z","lastActivity":"2026-10-25T10:00:00Z"}
                """
            return try JSONDecoder().decode(WireSession.self, from: Data(json.utf8))
        }
        var meta = SessionMeta(title: nil, costUSD: nil, lastMessage: nil)
        XCTAssertFalse(vault.session(try wire(meta), machines: []).terminal)
        meta.terminal = true
        XCTAssertTrue(vault.session(try wire(meta), machines: []).terminal)
        XCTAssertEqual(vault.session(try wire(meta), machines: []).commands, [.compact, .clear])
        // A newer agent says what it runs; names this app does not know are left out.
        meta.commands = ["compact", "interrupt", "rewind"]
        XCTAssertEqual(vault.session(try wire(meta), machines: []).commands, [.compact, .interrupt])
    }
}
