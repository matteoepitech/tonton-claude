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
}
