import XCTest

@testable import TontonCore

final class WhatsNewTests: XCTestCase {
    func testTheNotesShowOnceAfterAnUpdateOnly() {
        func launch(_ current: String?, shown: String = "", ranBefore: Bool = true, enabled: Bool = true) -> WhatsNew.Launch {
            WhatsNew.atLaunch(current: current, shown: shown, ranBefore: ranBefore, enabled: enabled)
        }
        // A fresh install records its version, the first launch of an update shows the notes.
        XCTAssertEqual(launch("0.7.0", ranBefore: false), .record)
        XCTAssertEqual(launch("0.7.0"), .show)
        XCTAssertEqual(launch("0.10.0", shown: "0.9.2"), .show)
        // Turned off: the version is still recorded, so turning it on later doesn't bring old notes back.
        XCTAssertEqual(launch("0.7.0", shown: "0.6.0", enabled: false), .record)
        // Once, and never for an older version put back.
        XCTAssertEqual(launch("0.7.0", shown: "0.7.0"), .nothing)
        XCTAssertEqual(launch("0.6.0", shown: "0.7.0"), .nothing)
        // Builds that are not releases neither show nor record anything.
        for version in [nil, "dev", "0.7.0-rc1", "0.0.0"] { XCTAssertEqual(launch(version, shown: "0.6.0"), .nothing) }
    }

    func testOnlyAnUnreachableGitHubIsWorthAnotherTry() throws {
        let page = "https://github.com/matteoepitech/tonton-claude/releases/tag/v0.7.0"
        let notes = Data(#"{"html_url":"\#(page)","body":"Hi"}"#.utf8)
        let release = WhatsNew.Release(body: "Hi", page: try XCTUnwrap(URL(string: page)))
        XCTAssertEqual(WhatsNew.Answer(status: 200, data: notes), .notes(release))
        XCTAssertEqual(WhatsNew.Answer(status: 200, data: Data(#"{"html_url":"\#(page)","body":""}"#.utf8)), .none)
        XCTAssertEqual(WhatsNew.Answer(status: 404, data: Data()), .none)
        for status in [nil, 403, 500] { XCTAssertEqual(WhatsNew.Answer(status: status, data: Data()), .unreachable) }
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
        XCTAssertEqual(WhatsNew.readable("## What's Changed\n* feat: x by @me"), "• feat: x by @me")
    }
}
