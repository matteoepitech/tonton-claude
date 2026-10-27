import XCTest

@testable import TontonCore

final class ChatItemTests: XCTestCase {
    func testToolCallsAreMergedWithTheirResult() {
        let entries = [
            Entry(id: "1", ts: "", kind: .user, text: "Run the tests"),
            Entry(id: "2", ts: "", kind: .tool, toolUseId: "t1", name: "Bash", summary: "npm test"),
            Entry(id: "3", ts: "", kind: .toolResult, text: "12 passed", toolUseId: "t1", isError: false),
            Entry(id: "4", ts: "", kind: .tool, toolUseId: "t2", name: "Bash", summary: "npm run deploy"),
            Entry(id: "5", ts: "", kind: .assistant, text: "Done"),
        ]
        let items = ChatItem.build(from: entries)
        XCTAssertEqual(items.map(\.id), ["1", "2", "4", "5"])
        guard case .tool(_, let result) = items[1], case .tool(_, let pending) = items[2] else { return XCTFail() }
        XCTAssertEqual(result?.text, "12 passed")
        XCTAssertNil(pending)
    }

    func testSubagentCallsGoUnderTheirTaskAndOutOfTheMainList() throws {
        let json = """
            [{"id":"t","ts":"2026-10-27T10:00:00Z","kind":"tool","toolUseId":"toolu_task","name":"Agent","summary":"Review"},
             {"id":"s1","ts":"2026-10-27T10:00:01Z","kind":"sub_tool","parent":"toolu_task","toolUseId":"toolu_1","name":"Bash","summary":"ls"},
             {"id":"s2","ts":"2026-10-27T10:00:02Z","kind":"sub_result","parent":"toolu_task","toolUseId":"toolu_1","text":"a","isError":false},
             {"id":"s3","ts":"2026-10-27T10:00:03Z","kind":"sub_tool","parent":"toolu_task","toolUseId":"toolu_2","name":"Read","summary":"b"},
             {"id":"o","ts":"2026-10-27T10:00:04Z","kind":"sub_tool","parent":"toolu_other","toolUseId":"toolu_3","name":"Grep","summary":"c"}]
            """
        let entries = try JSONDecoder().decode([Entry].self, from: Data(json.utf8))
        XCTAssertEqual(ChatItem.build(from: entries).map(\.id), ["t"])
        let steps = ChatItem.subagentSteps(in: entries)
        XCTAssertEqual(steps["toolu_task"]?.map(\.call.id), ["s1", "s3"])
        XCTAssertEqual(steps["toolu_task"]?.first?.result?.text, "a")
        XCTAssertNil(steps["toolu_task"]?.last?.result)
        XCTAssertEqual(steps["toolu_other"]?.count, 1)
    }
}
