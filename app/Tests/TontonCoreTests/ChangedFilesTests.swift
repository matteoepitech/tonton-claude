import XCTest

@testable import TontonCore

final class ChangedFilesTests: XCTestCase {
    private func call(_ id: String, _ name: String, _ path: String, edits: [FileEdit]? = nil, ts: String = "t") -> Entry {
        Entry(id: id, ts: ts, kind: .tool, toolUseId: id, name: name, summary: path, edits: edits)
    }

    private func result(_ id: String, failed: Bool = false) -> Entry {
        Entry(id: "\(id):result", ts: "t", kind: .toolResult, text: failed ? "String not found" : "ok", toolUseId: id, isError: failed)
    }

    func testFilesComeMostRecentlyChangedFirstWithTheirDiffs() {
        let first = FileEdit(oldText: "let a = 1", newText: "let a = 2")
        let second = FileEdit(oldText: "b()", newText: "c()")
        let files = ChangedFiles.list([
            call("e1", "Edit", "/srv/api/app.ts", edits: [first], ts: "1"), result("e1"),
            call("w1", "Write", "/srv/api/README.md", ts: "2"), result("w1"),
            Entry(id: "r1", ts: "3", kind: .tool, toolUseId: "r1", name: "Read", summary: "/srv/api/other.ts"),
            call("e2", "MultiEdit", "/srv/api/app.ts", edits: [second], ts: "4"), result("e2"),
        ])
        XCTAssertEqual(files.map(\.path), ["/srv/api/app.ts", "/srv/api/README.md"])
        XCTAssertEqual(files[0].edits, [first, second])
        XCTAssertEqual(files[0].changes, 2)
        XCTAssertEqual(files[0].lastChange, "4")
        XCTAssertFalse(files[0].written)
        // A Write call has no diff: it wrote the whole file.
        XCTAssertTrue(files[1].written)
        XCTAssertEqual(files[1].edits, [])
    }

    func testAFailedCallAddsNoDiffAndIsShownWhenItIsTheLast() {
        let kept = FileEdit(oldText: "x", newText: "y")
        let files = ChangedFiles.list([
            call("e1", "Edit", "/a.swift", edits: [kept]), result("e1"),
            call("e2", "Edit", "/a.swift", edits: [FileEdit(oldText: "missing", newText: "z")]), result("e2", failed: true),
            // Still running: counted, it has not failed.
            call("e3", "Edit", "/b.swift", edits: [kept]),
        ])
        let a = files.first { $0.path == "/a.swift" }
        XCTAssertEqual(a?.edits, [kept])
        XCTAssertEqual(a?.changes, 1)
        XCTAssertEqual(a?.lastFailed, true)
        XCTAssertEqual(files.first?.path, "/b.swift")
        XCTAssertEqual(files.first?.lastFailed, false)
    }

    func testASubagentsFileCallsCountWithoutDiffs() {
        let sub = { (id: String, name: String, path: String) in
            Entry(id: id, ts: "t", kind: .subagentTool, toolUseId: id, name: name, summary: path, parent: "task1")
        }
        let files = ChangedFiles.list([
            sub("s1", "Edit", "/srv/api/auth.ts"),
            sub("s2", "Write", "/srv/api/auth.test.ts"),
            Entry(id: "s2:r", ts: "t", kind: .subagentResult, text: "", toolUseId: "s2", isError: true, parent: "task1"),
            // The line that says a subagent made more calls than shown.
            sub("task1:more", "", "More calls not shown"),
        ])
        XCTAssertEqual(files.map(\.path), ["/srv/api/auth.test.ts", "/srv/api/auth.ts"])
        XCTAssertEqual(files.map(\.changes), [0, 1])
        XCTAssertEqual(files.map(\.lastFailed), [true, false])
        XCTAssertEqual(files[1].edits, [])
    }

    func testOnlyWholePathsCount() {
        let files = ChangedFiles.list([
            call("1", "Edit", "/very/long/path/that/was/cut…"),
            call("2", "Edit", "*** Begin Patch\n*** Update File: a.ts"),
            call("3", "Write", "src/relative.ts"),
            call("4", "Write", "C:\\code\\api\\main.go"),
            call("5", "Bash", "/usr/bin/true"),
        ])
        XCTAssertEqual(files.map(\.path), ["C:\\code\\api\\main.go"])
        XCTAssertEqual(files.first?.name, "main.go")
    }

    func testPathsAreShownUnderTheSessionFolder() {
        let file = ChangedFile(path: "/srv/api/src/app.ts", lastChange: "")
        XCTAssertEqual(file.shownPath(in: "/srv/api"), "src/app.ts")
        XCTAssertEqual(file.shownPath(in: "/srv/api/"), "src/app.ts")
        XCTAssertEqual(file.shownPath(in: "/srv/ap"), "/srv/api/src/app.ts")
        XCTAssertEqual(file.shownPath(in: "/other"), "/srv/api/src/app.ts")
        XCTAssertEqual(ChangedFile(path: "C:\\code\\api\\main.go", lastChange: "").shownPath(in: "C:\\code\\api"), "main.go")
        XCTAssertEqual(file.name, "app.ts")
    }
}
