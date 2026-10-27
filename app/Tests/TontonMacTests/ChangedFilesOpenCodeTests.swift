import XCTest

@testable import TontonCore
@testable import TontonMac

/// The files list (TontonCore) over this Mac's OpenCode sessions, which TontonMac reads.
final class ChangedFilesOpenCodeTests: XCTestCase {
    /// OpenCode's edit and write tools, as this Mac's OpenCode service lists them: the same files as Claude Code's.
    func testOpenCodeEditsAreListedLikeClaudeCodes() throws {
        let messages: [[String: Any]] = [
            ["id": "msg_u", "type": "user", "text": "Fix it", "time": ["created": 1_793_035_804_000]],
            [
                "id": "msg_a", "type": "assistant", "time": ["created": 1_793_035_805_000, "completed": 1_793_035_806_000],
                "content": [
                    [
                        "type": "tool", "id": "call_e", "name": "edit",
                        "state": [
                            "status": "completed",
                            "input": ["filePath": "/Users/me/code/shop/app.ts", "oldString": "a", "newString": "b"],
                            "content": [["type": "text", "text": "Edited"]],
                        ],
                    ],
                    [
                        "type": "tool", "id": "call_w", "name": "write",
                        "state": ["status": "error", "input": ["filePath": "/Users/me/code/shop/new.ts"], "error": ["message": "denied"]],
                    ],
                ],
            ],
        ]
        let data = try JSONSerialization.data(withJSONObject: ["data": messages])
        let files = ChangedFiles.list(OpenCodeLocal.conversation(data).entries)
        XCTAssertEqual(files.map(\.path), ["/Users/me/code/shop/new.ts", "/Users/me/code/shop/app.ts"])
        XCTAssertEqual(files[0].lastFailed, true)
        XCTAssertEqual(files[0].changes, 0)
        XCTAssertEqual(files[1].edits, [FileEdit(oldText: "a", newText: "b")])
    }
}
