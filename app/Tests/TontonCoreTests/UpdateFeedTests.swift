import XCTest

@testable import TontonCore

final class UpdateFeedTests: XCTestCase {
    private let feed = "https://github.com/matteoepitech/tonton-claude/releases/latest/download/appcast.xml"
    private let key = Data(repeating: 7, count: 32).base64EncodedString()

    func testAReleaseBuildUpdatesFromItsFeed() throws {
        let update = try XCTUnwrap(UpdateFeed(info: ["SUFeedURL": feed, "SUPublicEDKey": key, "CFBundleVersion": "412"]))
        XCTAssertEqual(update.url.absoluteString, feed)
    }

    func testBuildsWithoutTheKeyNeverCheck() {
        XCTAssertNil(UpdateFeed(info: [:]), "swift run, or a bundle built without SPARKLE_PUBLIC_KEY")
        XCTAssertNil(UpdateFeed(info: ["SUFeedURL": feed]))
        XCTAssertNil(UpdateFeed(info: ["SUFeedURL": feed, "SUPublicEDKey": ""]))
        XCTAssertNil(UpdateFeed(info: ["SUPublicEDKey": key]))
    }

    func testAMalformedKeyTurnsUpdatesOff() {
        XCTAssertNil(UpdateFeed(info: ["SUFeedURL": feed, "SUPublicEDKey": "not base64!"]))
        let short = Data(repeating: 7, count: 31).base64EncodedString()
        XCTAssertNil(UpdateFeed(info: ["SUFeedURL": feed, "SUPublicEDKey": short]))
        XCTAssertNil(UpdateFeed(info: ["SUFeedURL": feed, "SUPublicEDKey": 42]))
    }

    func testTheFeedMustBeHTTPS() {
        XCTAssertNil(UpdateFeed(info: ["SUFeedURL": "http://example.com/appcast.xml", "SUPublicEDKey": key]))
        XCTAssertNil(UpdateFeed(info: ["SUFeedURL": "https://", "SUPublicEDKey": key]))
        XCTAssertNil(UpdateFeed(info: ["SUFeedURL": "appcast.xml", "SUPublicEDKey": key]))
    }
}
