import XCTest

@testable import TontonCore

final class SpokenTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_793_005_200)

    override func setUpWithError() throws { try Catalog.use("en") }
    override func tearDown() { Catalog.reset() }

    private func request(_ id: String, _ tool: String, _ description: String = "") -> PermissionRequest {
        PermissionRequest(requestId: id, toolName: tool, description: description, inputPreview: "", ts: "2026-10-27T09:00:00Z")
    }

    func testAStatusDotSaysTheStateAndTheLimitItsRingShows() {
        XCTAssertEqual(Spoken.status(.working, limit: nil, at: now), "Working")
        XCTAssertEqual(Spoken.status(.permission, limit: nil, at: now), "Needs approval")
        let limit = UsageLimit(usedPercent: 42.4, resetsAt: now.addingTimeInterval(3600))
        XCTAssertEqual(Spoken.status(.working, limit: limit, at: now), "Working, 5-hour limit 42 % used")
        // No ring once the window has reset, so nothing to say about it.
        XCTAssertEqual(Spoken.status(.idle, limit: UsageLimit(usedPercent: 99, resetsAt: now), at: now), "Done")
    }

    func testOneNewRequestIsAnnouncedWithWhatItWants() {
        XCTAssertEqual(
            Spoken.permissions([request("r1", "Bash", "Run the tests")], session: "tonton-claude"),
            "tonton-claude asks to use Bash: Run the tests")
        XCTAssertEqual(Spoken.permissions([request("r1", "Edit", "  ")], session: "relay"), "relay asks to use Edit")
    }

    func testSeveralRequestsAreAnnouncedAtOnce() {
        XCTAssertEqual(
            Spoken.permissions([request("r1", "Bash"), request("r2", "Edit")], session: "tonton-claude"),
            "tonton-claude asks for 2 permissions: Bash, Edit")
    }

    func testOnlyRequestsThatJustArrivedAreAnnounced() {
        let first = request("r1", "Bash"), second = request("r2", "Edit")
        XCTAssertEqual(PermissionRequest.added([first], since: []), [first])
        XCTAssertEqual(PermissionRequest.added([first, second], since: [first]), [second])
        // Answering one of two requests announces nothing.
        XCTAssertEqual(PermissionRequest.added([second], since: [first, second]), [])
        XCTAssertEqual(PermissionRequest.added([], since: [first]), [])
    }

    func testCountsReadNaturally() {
        XCTAssertEqual(Spoken.liveSessions(1), "1 live session")
        XCTAssertEqual(Spoken.liveSessions(3), "3 live sessions")
        XCTAssertEqual(Spoken.liveSessions(0), "No live session")
        XCTAssertEqual(Spoken.moreSessions(1), "1 more session")
        XCTAssertEqual(Spoken.moreSessions(4), "4 more sessions")
    }
}
