import XCTest

@testable import TontonCore

final class WhatsNewTests: XCTestCase {
    func testTheNotesShowOnceAfterAnUpdateOnly() {
        // A fresh install, then the first launch of an update.
        XCTAssertFalse(WhatsNew.shouldShow(current: "0.7.0", shown: nil, ranBefore: false))
        XCTAssertTrue(WhatsNew.shouldShow(current: "0.7.0", shown: nil, ranBefore: true))
        XCTAssertTrue(WhatsNew.shouldShow(current: "0.7.0", shown: "", ranBefore: true))
        XCTAssertTrue(WhatsNew.shouldShow(current: "0.10.0", shown: "0.9.2", ranBefore: true))
        // Once, and never for an older version put back.
        XCTAssertFalse(WhatsNew.shouldShow(current: "0.7.0", shown: "0.7.0", ranBefore: true))
        XCTAssertFalse(WhatsNew.shouldShow(current: "0.6.0", shown: "0.7.0", ranBefore: true))
        // Builds that are not releases.
        XCTAssertFalse(WhatsNew.shouldShow(current: nil, shown: "0.6.0", ranBefore: true))
        XCTAssertFalse(WhatsNew.shouldShow(current: "dev", shown: "0.6.0", ranBefore: true))
        XCTAssertFalse(WhatsNew.shouldShow(current: "0.7.0-beta", shown: "0.6.0", ranBefore: true))
        XCTAssertFalse(WhatsNew.shouldShow(current: "0.0.0", shown: "", ranBefore: true))
    }

    func testTheReleaseOfAVersionIsItsTag() {
        let url = WhatsNew.releaseURL(for: "0.7.0")
        XCTAssertEqual(url?.absoluteString, "https://api.github.com/repos/matteoepitech/tonton-claude/releases/tags/v0.7.0")
        XCTAssertNil(WhatsNew.releaseURL(for: "../../users"))
    }

    func testReleasesDecodeFromGitHubsAnswer() throws {
        let json = """
            {"tag_name":"v0.7.0","html_url":"https://github.com/matteoepitech/tonton-claude/releases/tag/v0.7.0",
             "body":"## What's new\\r\\n- Model switch","draft":false}
            """
        let release = try XCTUnwrap(WhatsNew.Release.decode(Data(json.utf8)))
        XCTAssertEqual(release.page.absoluteString, "https://github.com/matteoepitech/tonton-claude/releases/tag/v0.7.0")
        XCTAssertEqual(WhatsNew.readable(release.body), "• Model switch")
        XCTAssertNil(WhatsNew.Release.decode(Data(#"{"message":"Not Found"}"#.utf8)))
        XCTAssertNil(WhatsNew.Release.decode(Data(#"{"html_url":"https://github.com","body":"  "}"#.utf8)))
    }

    func testListItemsGetABulletAndKeepTheirIndent() {
        let notes = "**Chat**\n- Tables\n  * Nested\n-not a list\n\n**Full changelog**: x"
        XCTAssertEqual(WhatsNew.readable(notes), "**Chat**\n• Tables\n  • Nested\n-not a list\n\n**Full changelog**: x")
        // Only a first heading repeats the title.
        XCTAssertEqual(WhatsNew.readable("## What's new\n\nText\n## What's new"), "Text\n## What's new")
    }
}
