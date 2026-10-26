import XCTest

@testable import TontonCore

final class ConversationExportTests: XCTestCase {
    private let image = ImageData(mediaType: "image/png", data: "iVBORw0")
    private var entries: [Entry] {
        [
            Entry(id: "1", ts: "", kind: .user, text: "Fix <the> build", images: [image]),
            Entry(id: "2", ts: "", kind: .assistant, text: "Done: **all** tests pass.\n\n| a | b |\n|---|--:|\n| 1 | `2` |"),
            Entry(id: "3", ts: "", kind: .tool, toolUseId: "t", name: "Bash", summary: "npm test"),
            Entry(id: "4", ts: "", kind: .toolResult, text: "12 passed", toolUseId: "t", isError: false),
            Entry(id: "5", ts: "", kind: .system, text: "Conversation compacted"),
        ]
    }

    func testMarkdownEmbedsImages() {
        let md = ConversationExport.render(.markdown, title: "app", subtitle: "Mac · /app", entries: entries)
        XCTAssertTrue(md.hasPrefix("# app\n\n_Mac · /app_\n\n"))
        XCTAssertTrue(md.contains("**You:** Fix <the> build"))
        XCTAssertTrue(md.contains("![image](data:image/png;base64,iVBORw0)"))
        XCTAssertTrue(md.contains("- `Bash` npm test"))
        XCTAssertTrue(md.contains("> Conversation compacted"))
    }

    func testHTMLIsEscapedStyledAndStandsOnItsOwn() {
        let html = ConversationExport.render(.html, title: "app <1>", subtitle: "Mac", entries: entries)
        XCTAssertTrue(html.hasPrefix("<!doctype html>"))
        XCTAssertTrue(html.contains("<title>app &lt;1&gt;</title>"))
        XCTAssertTrue(html.contains("Fix &lt;the&gt; build"))
        XCTAssertTrue(html.contains("<img src=\"data:image/png;base64,iVBORw0\""))
        XCTAssertTrue(html.contains("<strong>all</strong>"))
        XCTAssertTrue(html.contains("<td style=\"text-align:right\"><code>2</code></td>"))
        XCTAssertTrue(html.contains("<summary><b>Bash</b> npm test</summary><pre>12 passed</pre>"))
        XCTAssertFalse(html.contains("http://") || html.contains("https://"), "no external resource")
    }

    func testInlineStyles() {
        XCTAssertEqual(
            ConversationExport.inline("a *b* `c` [d](https://x.dev) 2*3"),
            "a <em>b</em> <code>c</code> <a href=\"https://x.dev\">d</a> 2*3")
    }
}
