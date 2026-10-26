import XCTest

@testable import TontonCore

final class DiffTests: XCTestCase {
    func testAChangedLineReadsAsRemovedThenAdded() {
        let lines = LineDiff.lines(old: "let a = 1\nlet b = 2\nreturn a", new: "let a = 1\nlet b = 3\nlet c = 4\nreturn a")
        XCTAssertEqual(
            lines,
            [
                .init(.same, "let a = 1"), .init(.removed, "let b = 2"), .init(.added, "let b = 3"), .init(.added, "let c = 4"),
                .init(.same, "return a"),
            ])
        XCTAssertEqual(LineDiff.lines(old: "", new: "x"), [.init(.added, "x")])
        XCTAssertEqual(LineDiff.lines(old: "x", new: ""), [.init(.removed, "x")])
    }

    func testHugeEditsAreShownWholeRatherThanCompared() {
        let old = (0..<500).map { "line \($0)" }.joined(separator: "\n")
        let lines = LineDiff.lines(old: old, new: "short")
        XCTAssertEqual(lines.count, 501)
        XCTAssertEqual(lines.last, .init(.added, "short"))
    }

    func testSyntaxColours() {
        let tokens = Syntax.tokens(#"let name = "a \"b\"" // say 42"#, fileExtension: "swift")
        XCTAssertEqual(tokens.first?.text, "let")
        XCTAssertEqual(tokens.first?.token, .keyword)
        XCTAssertTrue(tokens.contains { $0.text == #""a \"b\"""# && $0.token == .string })
        XCTAssertEqual(tokens.last?.text, "// say 42")
        XCTAssertEqual(tokens.last?.token, .comment)
        XCTAssertEqual(tokens.map(\.text).joined(), #"let name = "a \"b\"" // say 42"#)
        XCTAssertEqual(Syntax.tokens("x = 1  # set", fileExtension: "py").last?.token, .comment)
        XCTAssertEqual(Syntax.tokens("n = 3.5", fileExtension: "py").last?.token, .number)
    }

    func testEditCallsCarryTheirReplacements() {
        let input: [String: Any] = ["file_path": "/a.ts", "edits": [["old_string": "x", "new_string": "y"], ["old_string": 1]]]
        XCTAssertEqual(Transcript.fileEdits("MultiEdit", input), [FileEdit(oldText: "x", newText: "y")])
        XCTAssertEqual(Transcript.fileEdits("Edit", ["old_string": "a", "new_string": "b"]), [FileEdit(oldText: "a", newText: "b")])
        XCTAssertEqual(Transcript.fileEdits("Read", ["file_path": "/a.ts"]), [])
        XCTAssertEqual(
            Transcript.fileEdits("Edit", ["old_string": String(repeating: "a", count: 5000), "new_string": ""])[0].oldText.count, 4002)
    }
}
