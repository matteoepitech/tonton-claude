import XCTest

@testable import TontonCore

final class OpenCodeLocalTests: XCTestCase {
    /// A real `session.context` of OpenCode 2.0.32, the agent's fixture (agent/test/fixtures).
    private func fixture() throws -> [String: Any] {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../agent/test/fixtures/opencode-2.0.32-context.json")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    private func data(_ object: Any) throws -> Data { try JSONSerialization.data(withJSONObject: object) }

    func testTheServiceIsFoundOnThisMacOnly() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("opencode-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        let state = home.appendingPathComponent(".local/state/opencode")
        try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true)
        let write = { (url: String) in
            try Data(#"{"url":"\#(url)","password":"pw","pid":1}"#.utf8).write(to: state.appendingPathComponent("service.json"))
        }
        try write("http://127.0.0.1:49374")
        let service = try XCTUnwrap(OpenCodeLocal.service(home: home, environment: [:]))
        XCTAssertEqual(service.url.absoluteString, "http://127.0.0.1:49374")
        XCTAssertEqual(service.authorization, "Basic " + Data("opencode:pw".utf8).base64EncodedString())
        // Its password must not go to another machine.
        try write("http://10.0.0.5:49374")
        XCTAssertNil(OpenCodeLocal.service(home: home, environment: [:]))
        XCTAssertNil(OpenCodeLocal.service(home: home.appendingPathComponent("nowhere"), environment: [:]))
    }

    func testRecentSessionsOfTheList() throws {
        let now = Date(timeIntervalSince1970: 1_793_035_900)
        let list: [String: Any] = [
            "data": [
                [
                    "id": "ses_1", "title": "Probe title", "location": ["directory": "/Users/me/code/shop"], "cost": 0.5,
                    "outcome": "succeeded",
                    "time": ["created": 1_793_035_804_171, "updated": 1_793_035_805_987, "idle": 1_793_035_805_988],
                    "tokens": ["input": 360, "output": 90, "reasoning": 10, "cache": ["read": 5, "write": 0]],
                    "model": ["id": "claude-sonnet-5-5", "providerID": "anthropic"],
                ],
                ["id": "ses_old", "location": ["directory": "/x"], "time": ["created": 1, "updated": 1]],
                ["id": "ses_child", "parentID": "ses_1", "location": ["directory": "/x"], "time": ["created": 1_793_035_804_171]],
            ]
        ]
        let sessions = OpenCodeLocal.sessions(try data(list), now: now)
        XCTAssertEqual(sessions.map(\.id), ["ses_1"])
        XCTAssertEqual(sessions.first?.tokens, TokenCounts(input: 360, output: 100, cacheRead: 5, cacheWrite: 0))
        XCTAssertEqual(sessions.first?.model, "claude-sonnet-5-5")
    }

    func testTheConversationHasTheIdsTheAgentGivesIt() throws {
        let conversation = OpenCodeLocal.conversation(try data(["data": try fixture()["messages"] as Any]))
        let kinds = conversation.entries.map { ($0.kind, $0.text ?? $0.name ?? "") }
        XCTAssertEqual(kinds.map(\.0), [.user, .assistant, .tool, .toolResult, .assistant])
        XCTAssertEqual(
            kinds.map(\.1), ["Say hi with bash", "Let me check.", "Bash", "hi-from-probe\n", "Done: the command printed hi-from-probe."])
        let messages = try XCTUnwrap(try fixture()["messages"] as? [[String: Any]])
        let assistant = try XCTUnwrap(messages[1]["id"] as? String)
        // As in agent/src/opencode/events.ts: the relay's copy and this one line up entry for entry.
        XCTAssertEqual(conversation.entries[1].id, "\(assistant):0")
        XCTAssertEqual(conversation.entries[2].id, "call_probe1")
        XCTAssertEqual(conversation.entries[3].id, "call_probe1:result")
        XCTAssertEqual(conversation.entries[2].summary, "echo hi-from-probe")
        XCTAssertFalse(conversation.working)
        XCTAssertEqual(conversation.contextTokens, 120)
    }

    func testStatusFromTheConversationAndTheRequests() throws {
        let listed = try XCTUnwrap(
            OpenCodeLocal.listed(["id": "ses_1", "location": ["directory": "/Users/me/code/shop"], "time": ["created": 1, "updated": 2]]))
        var conversation = OpenCodeLocal.Conversation()
        XCTAssertEqual(OpenCodeLocal.summary(listed, conversation, permissions: []).status, .idle)
        conversation.working = true
        let working = OpenCodeLocal.summary(listed, conversation, permissions: [])
        XCTAssertEqual(working.status, .working)
        XCTAssertEqual(working.project, "shop")
        XCTAssertEqual(working.tool, "opencode")
        XCTAssertTrue(working.canChat)
        XCTAssertEqual(working.commands, [.compact])
        let requests = OpenCodeLocal.permissions(
            try data([
                "data": [
                    [
                        "id": "per_178d233be001SD9XK3POsEuPXF", "sessionID": "ses_1", "action": "shell",
                        "resources": ["echo hi-from-probe"],
                        "save": ["echo *"], "source": ["type": "tool", "id": "call_probe1"],
                    ]
                ]
            ]))
        XCTAssertEqual(requests.map(\.toolName), ["Bash"])
        XCTAssertEqual(requests.first?.description, "echo hi-from-probe")
        XCTAssertEqual(requests.first?.inputPreview, #"{"command":"echo hi-from-probe"}"#)
        let asking = OpenCodeLocal.summary(listed, conversation, permissions: requests)
        XCTAssertEqual(asking.status, .permission)
        XCTAssertEqual(asking.displayStatusText, "Wants to use Bash")
        // A failed turn.
        let failed = try XCTUnwrap(
            OpenCodeLocal.listed(["id": "ses_2", "location": ["directory": "/x"], "outcome": "failed", "time": ["created": 1]]))
        XCTAssertEqual(OpenCodeLocal.summary(failed, OpenCodeLocal.Conversation(), permissions: []).status, .error)
    }

    func testAnythingUnexpectedIsSkipped() {
        XCTAssertTrue(OpenCodeLocal.sessions(Data("nope".utf8)).isEmpty)
        XCTAssertEqual(OpenCodeLocal.conversation(Data(#"{"data":[{"type":"user"},3]}"#.utf8)), OpenCodeLocal.Conversation())
        XCTAssertTrue(OpenCodeLocal.permissions(Data(#"{"data":"x"}"#.utf8)).isEmpty)
    }
}
