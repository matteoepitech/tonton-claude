import XCTest

@testable import TontonCore

/// The same cases as agent/test/parser.test.ts: both parsers must read a transcript the same way.
final class TranscriptTests: XCTestCase {
    private let ts = "2026-10-25T10:00:00Z"

    private func line(_ fields: [String: Any]) -> String {
        let all = fields.merging(["uuid": "u1", "timestamp": ts]) { mine, _ in mine }
        return String(decoding: (try? JSONSerialization.data(withJSONObject: all)) ?? Data(), as: UTF8.self)
    }

    func testUserPromptAsAString() {
        XCTAssertEqual(
            Transcript.parse(line(["type": "user", "message": ["content": "hello"]])).entries,
            [Entry(id: "u1", ts: ts, kind: .user, text: "hello")])
    }

    func testAssistantTextAndToolCallsHidingToolSearch() {
        let content: [[String: Any]] = [
            ["type": "text", "text": "On it."],
            ["type": "tool_use", "id": "t1", "name": "Bash", "input": ["command": "npm   test"]],
            ["type": "tool_use", "id": "t2", "name": "ToolSearch", "input": ["query": "select:Write"]],
        ]
        let entries = Transcript.parse(line(["type": "assistant", "message": ["content": content]])).entries
        XCTAssertEqual(entries.map(\.kind), [.assistant, .tool])
        XCTAssertEqual(entries[1], Entry(id: "u1:1", ts: ts, kind: .tool, toolUseId: "t1", name: "Bash", summary: "npm test"))
    }

    func testToolResultsAreTruncatedAndKeepTheErrorFlag() {
        let result: [String: Any] = [
            "type": "tool_result", "tool_use_id": "t1", "content": String(repeating: "x", count: 5000), "is_error": true,
        ]
        let entry = Transcript.parse(line(["type": "user", "message": ["content": [result]]])).entries[0]
        XCTAssertEqual(entry.kind, .toolResult)
        XCTAssertEqual(entry.toolUseId, "t1")
        XCTAssertEqual(entry.isError, true)
        XCTAssertTrue(entry.text?.contains("characters truncated") == true)
    }

    func testImagesPastedWithAPromptAreKept() {
        let image: [String: Any] = ["type": "image", "source": ["type": "base64", "media_type": "image/png", "data": "iVBORw0"]]
        let content: [[String: Any]] = [["type": "text", "text": "[Image #1] like this"], image]
        let entry = Transcript.parse(line(["type": "user", "message": ["content": content]])).entries[0]
        XCTAssertEqual(entry.images, [ImageData(mediaType: "image/png", data: "iVBORw0")])
    }

    func testMessagesSentFromTheNotchAreUnwrapped() {
        let raw = line([
            "type": "user", "isMeta": true, "origin": ["kind": "channel"],
            "message": ["content": "<channel source=\"tonton\" sender=\"notch\">\nShip it\n</channel>"],
        ])
        XCTAssertEqual(Transcript.parse(raw).entries, [Entry(id: "u1", ts: ts, kind: .user, text: "Ship it", viaNotch: true)])
    }

    func testMessagesSentWhileClaudeIsWorkingAreReadFromTheQueue() {
        func queued(_ attachment: [String: Any]) -> [Entry] {
            Transcript.parse(line(["type": "attachment", "attachment": attachment.merging(["type": "queued_command"]) { a, _ in a }]))
                .entries
        }
        XCTAssertEqual(
            queued([
                "commandMode": "prompt", "origin": ["kind": "channel", "server": "tonton"],
                "prompt": "<channel source=\"tonton\" sender=\"notch\">\nAlso run the linter\n</channel>",
            ]),
            [Entry(id: "u1", ts: ts, kind: .user, text: "Also run the linter", viaNotch: true)])
        XCTAssertEqual(
            queued(["commandMode": "prompt", "origin": ["kind": "channel"], "prompt": "Also run the linter"]).first?.viaNotch, true)
        XCTAssertEqual(
            queued(["commandMode": "prompt", "origin": ["kind": "human"], "prompt": [["type": "text", "text": "and the docs"]]]),
            [Entry(id: "u1", ts: ts, kind: .user, text: "and the docs")])
        XCTAssertEqual(queued(["commandMode": "task-notification", "prompt": "<task-notification>x</task-notification>"]), [])
        XCTAssertEqual(Transcript.parse(line(["type": "attachment", "attachment": ["type": "date"]])).entries, [])
    }

    func testInternalAndMetaMessagesAreSkippedCommandsBecomeSystemEntries() {
        XCTAssertEqual(Transcript.parse(line(["type": "user", "isMeta": true, "message": ["content": "skill text"]])).entries, [])
        XCTAssertEqual(
            Transcript.parse(line(["type": "user", "message": ["content": "<system-reminder>x</system-reminder>"]])).entries, [])
        let command = Transcript.parse(
            line(["type": "user", "message": ["content": "<command-name>/model</command-name><command-args>opus</command-args>"]]))
        XCTAssertEqual(command.entries.first?.kind, .system)
        XCTAssertEqual(command.entries.first?.text, "/model opus")
    }

    func testTitleCostAndCompaction() {
        XCTAssertEqual(Transcript.parse(line(["type": "ai-title", "aiTitle": "Fix login"])).title, "Fix login")
        XCTAssertEqual(Transcript.parse(line(["type": "cost-state", "totalCostUSD": 0.42])).costUSD, 0.42)
        XCTAssertEqual(Transcript.parse(line(["type": "system", "subtype": "compact_boundary"])).entries.first?.kind, .system)
    }

    func testGarbageAndSubagentLinesAreIgnored() {
        XCTAssertEqual(Transcript.parse("{not json").entries, [])
        XCTAssertEqual(Transcript.parse(line(["type": "user", "isSidechain": true, "message": ["content": "x"]])).entries, [])
    }

    func testPicksTheMostTellingFieldPerTool() {
        XCTAssertEqual(Transcript.toolSummary("Read", ["file_path": "a.ts"]), "a.ts")
        XCTAssertEqual(Transcript.toolSummary("Grep", ["pattern": "TODO", "path": "src"]), "TODO in src")
        XCTAssertEqual(Transcript.toolSummary("mcp__x__y", ["url": "https://x.dev"]), "https://x.dev")
        XCTAssertEqual(Transcript.toolSummary("Bash", ["command": String(repeating: "a", count: 400)]).count, 301)
    }
}
