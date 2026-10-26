import XCTest

@testable import TontonCore

final class TranscriptTailTests: XCTestCase {
    private var url: URL!

    override func setUp() {
        url = FileManager.default.temporaryDirectory.appendingPathComponent("tail-\(UUID().uuidString).jsonl")
    }

    override func tearDown() { try? FileManager.default.removeItem(at: url) }

    private func append(_ text: String) throws {
        if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
        let handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(text.utf8))
        try handle.close()
    }

    func testOnlyWholeLinesAndWhatWasAppendedSince() throws {
        let tail = TranscriptTail(url: url)
        XCTAssertEqual(tail.read().lines, [])
        try append("one\ntw")
        XCTAssertEqual(tail.read().lines, ["one"])
        try append("o\n\nthree é\n")
        XCTAssertEqual(tail.read().lines, ["two", "three é"])
        XCTAssertEqual(tail.read().lines, [])
    }

    func testAShorterFileStartsOver() throws {
        let tail = TranscriptTail(url: url)
        try append("one\ntwo\n")
        _ = tail.read()
        try Data("new\n".utf8).write(to: url)
        XCTAssertEqual(tail.read(), TranscriptTail.Read(lines: ["new"], reset: true))
    }
}
