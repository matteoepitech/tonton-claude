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

    func testSwitchingTheModelSealsOneOfTheAliases() throws {
        let sealed = try vault.sealCommand(.model, model: .haiku, for: "s1", issuedAt: now)
        let payload = try E2E.open(sealed, as: PromptPayload.self, with: key)
        XCTAssertEqual(payload.command?.name, .model)
        XCTAssertEqual(payload.command?.model, .haiku)
        // As the agent reads it.
        let json = String(decoding: try JSONEncoder().encode(payload.command), as: UTF8.self)
        XCTAssertTrue(json.contains(#""name":"model""#) && json.contains(#""model":"haiku""#))
        let compact = try E2E.open(try vault.sealCommand(.compact, for: "s1"), as: PromptPayload.self, with: key)
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(compact.command), as: UTF8.self).contains("model"))
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
        // Agents from before `model` don't list their commands, and can't switch it.
        XCTAssertEqual(vault.session(try wire(meta), machines: []).commands, [.compact, .clear])
        XCTAssertNil(vault.session(try wire(meta), machines: []).model)
        meta.commands = ["compact", "clear", "model", "interrupt"]
        meta.model = "claude-sonnet-5-5"
        let session = vault.session(try wire(meta), machines: [])
        XCTAssertEqual(session.commands, [.compact, .clear, .model])
        XCTAssertEqual(session.modelName, "Sonnet 5.5")
        XCTAssertEqual(session.modelFamily, .sonnet)
    }

    func testModelsAreNamedLikeClaudeCodesMenuDoes() {
        let names = [
            "claude-opus-4-5-20251101": "Opus 4.5",
            "claude-sonnet-5-5[1m]": "Sonnet 5.5",
            "claude-haiku-5-5": "Haiku 5.5",
            "claude-opus-4-20250514": "Opus 4",
            "claude-3-5-sonnet-20241022": "Sonnet 3.5",
            "claude-3-opus-20240229": "Opus 3",
            "us.anthropic.claude-haiku-4-5-20251001-v1:0": "Haiku 4.5",
            "claude-haiku-4-5@20251001": "Haiku 4.5",
            "claude-fable-5-1": "Fable 5.1",
            "claude-3-5-haiku-latest": "Haiku 3.5",
            "sonnet": "Sonnet",
            "gpt-5": "gpt-5",
            "claude-instant": "claude-instant",
        ]
        for (id, name) in names { XCTAssertEqual(ModelName.display(id), name, id) }
        XCTAssertEqual(ModelName.family("us.anthropic.claude-opus-4-1-20250805-v1:0"), .opus)
        XCTAssertEqual(ModelName.family("claude-3-5-haiku-20241022"), .haiku)
        XCTAssertNil(ModelName.family("claude-fable-5-1"))
        XCTAssertNil(ModelName.family("gpt-5"))
    }
}
