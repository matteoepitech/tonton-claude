import XCTest

@testable import TontonCore

final class EntryTests: XCTestCase {
    private func tool(_ name: String, _ summary: String) -> Entry {
        Entry(id: "1", ts: "", kind: .tool, toolUseId: "t1", name: name, summary: summary)
    }

    func testFileToolsGiveTheirAbsolutePath() {
        XCTAssertEqual(tool("Read", "/Users/del/app/Package.swift").filePath, "/Users/del/app/Package.swift")
        XCTAssertEqual(tool("Edit", "/tmp/a b.txt").filePath, "/tmp/a b.txt")
        XCTAssertEqual(tool("NotebookEdit", "/x/analysis.ipynb").filePath, "/x/analysis.ipynb")
    }

    func testNoPathWhenItIsNotAWholeLocalFile() {
        XCTAssertNil(tool("Bash", "/usr/bin/true").filePath)
        XCTAssertNil(tool("Read", "C:\\Users\\del\\notes.txt").filePath)
        XCTAssertNil(tool("Read", "src/main.ts").filePath)
        XCTAssertNil(tool("Write", "/very/long/path/that/was/cut…").filePath)
        XCTAssertNil(Entry(id: "2", ts: "", kind: .toolResult, toolUseId: "t1", name: "Read", summary: "/tmp/x").filePath)
    }
}
