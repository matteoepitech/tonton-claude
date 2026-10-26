import XCTest

@testable import TontonCore

final class MarkdownTests: XCTestCase {
    func testTableIsSplitFromTheProseAroundIt() {
        let text = """
            Results:
            | Name | Tests | Status |
            |:-----|------:|:------:|
            | **api** | 12 | ok |
            | `web` | 3 |
            Done.
            """
        guard case .table(let table) = MarkdownBlock.parse(text)[1] else { return XCTFail() }
        XCTAssertEqual(MarkdownBlock.parse(text).count, 3)
        XCTAssertEqual(MarkdownBlock.parse(text).first, .prose("Results:"))
        XCTAssertEqual(MarkdownBlock.parse(text).last, .prose("Done."))
        XCTAssertEqual(table.header, ["Name", "Tests", "Status"])
        XCTAssertEqual(table.alignments, [.leading, .trailing, .center])
        XCTAssertEqual(table.rows, [["**api**", "12", "ok"], ["`web`", "3", ""]])
    }

    func testOuterPipesAreOptionalAndEscapedPipesStayInTheCell() {
        let blocks = MarkdownBlock.parse("a | b\n--- | ---\n`x \\| y` | 2 | extra\n\nafter")
        guard case .table(let table) = blocks.first else { return XCTFail() }
        XCTAssertEqual(table.header, ["a", "b"])
        XCTAssertEqual(table.rows, [["`x | y`", "2"]])
        XCTAssertEqual(blocks.last, .prose("after"))
    }

    func testPipesWithoutADelimiterRowOrInsideCodeStayAsTheyAre() {
        XCTAssertEqual(MarkdownBlock.parse("a | b\nc | d"), [.prose("a | b\nc | d")])
        XCTAssertEqual(MarkdownBlock.parse("| a | b |\n|---|\n"), [.prose("| a | b |\n|---|")])
        XCTAssertEqual(MarkdownBlock.parse("```\n| a |\n|---|\n```"), [.code("| a |\n|---|")])
    }
}
