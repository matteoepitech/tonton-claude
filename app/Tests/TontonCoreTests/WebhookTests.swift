import XCTest

@testable import TontonCore

final class WebhookTests: XCTestCase {
    private let session = SessionSummary(
        id: "s", machineId: "m", machine: "del-mbp", platform: nil, cwd: "/", project: "tonton", title: nil, status: .permission,
        statusText: nil, agentOnline: true, canChat: true, pendingPermissions: [], costUSD: nil, startedAt: Date(),
        lastActivity: Date(), lastMessage: "Deploying with the secret key")

    func testNothingAboutTheSessionByDefault() {
        let text = Webhook.message(.needsYou, session, privacy: .init())
        XCTAssertEqual(text, "A Claude session needs you: needs approval.")
        XCTAssertFalse(text.contains("tonton") || text.contains("del-mbp") || text.contains("secret"))
        XCTAssertEqual(Webhook.message(.finished, session, privacy: .init()), "A Claude session finished.")
    }

    func testNamesAndTheLastMessageOnlyWhenAllowed() {
        XCTAssertEqual(Webhook.message(.finished, session, privacy: .init(includeNames: true)), "Claude (tonton on del-mbp) finished.")
        XCTAssertEqual(
            Webhook.message(.finished, session, privacy: .init(includeLastMessage: true)),
            "A Claude session finished.\n> Deploying with the secret key")
    }

    func testEachServiceGetsTheFieldItReads() throws {
        func json(_ url: String) throws -> [String: String] {
            let body = Webhook.body(for: try XCTUnwrap(URL(string: url)), message: "hi")
            return try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        }
        XCTAssertEqual(try json("https://discord.com/api/webhooks/1/x"), ["content": "hi"])
        XCTAssertEqual(try json("https://hooks.slack.com/services/T/B/x"), ["text": "hi"])
        XCTAssertEqual(try json("https://example.com/hook"), ["text": "hi", "content": "hi"])
    }

    func testOnlyHTTPS() {
        XCTAssertNotNil(Webhook.url(" https://discord.com/api/webhooks/1/x "))
        XCTAssertNil(Webhook.url("http://example.com/hook"))
        XCTAssertNil(Webhook.url("not a url"))
        XCTAssertNil(Webhook.url(""))
    }
}
