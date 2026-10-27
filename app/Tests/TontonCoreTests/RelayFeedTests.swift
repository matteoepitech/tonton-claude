import XCTest

@testable import TontonCore

final class RelayFeedTests: XCTestCase {
    private func message(_ json: String) throws -> RelayMessage {
        try JSONDecoder().decode(RelayMessage.self, from: Data(json.utf8))
    }

    private func session(_ id: String, _ status: String, at minute: Int, info: String = "null", pending: String = "[]") -> String {
        """
        {"id":"\(id)","machineId":"m1","status":"\(status)","agentOnline":true,"canChat":true,"info":\(info),"meta":null,\
        "statusDetail":null,"pendingPermissions":\(pending),"startedAt":"2026-10-26T10:00:00.000Z",\
        "lastActivity":"2026-10-26T10:\(String(format: "%02d", minute)):00.000Z"}
        """
    }

    func testFollowsTheRelayFromSnapshotToUpdates() throws {
        let vault = try AgentBlobs.vault()
        var feed = RelayFeed()
        let pending = #"[{"requestId":"r1","ts":"2026-10-26T10:03:00.000Z","blob":"\#(AgentBlobs.request)"}]"#
        try feed.apply(
            message(
                #"{"t":"snapshot","sessions":[\#(session("old", "ended", at: 9)),\#(session("a", "working", at: 1, info: "\"\(AgentBlobs.info)\""))],"machines":[]}"#
            ), vault: vault)
        XCTAssertEqual(feed.sessions.map(\.id), ["a", "old"], "live sessions first")
        XCTAssertEqual(feed.session("a")?.project, "api")

        try feed.apply(message(#"{"t":"session","session":\#(session("a", "permission", at: 4, pending: pending))}"#), vault: vault)
        XCTAssertEqual(feed.session("a")?.pendingPermissions.first?.toolName, "Bash")
        XCTAssertEqual(feed.island.attention, 1)
        XCTAssertEqual(feed.island.sessions.map(\.id), ["a"])

        try feed.apply(message(#"{"t":"removed","sessionId":"old"}"#), vault: vault)
        XCTAssertEqual(feed.sessions.map(\.id), ["a"])
        try feed.apply(message(#"{"t":"error","message":"This session does not accept messages."}"#), vault: vault)
        XCTAssertEqual(feed.lastError, "This session does not accept messages.")
        feed.clearError()
        XCTAssertNil(feed.lastError)
    }

    /// An alert's Allow or Deny goes out only while its request waits on a connected agent, and it is done once the
    /// relay drops the request.
    func testWhereTheRequestOfAnAlertStands() throws {
        let vault = try AgentBlobs.vault()
        var feed = RelayFeed()
        let alert = PermissionPush(sessionId: "a", requestId: "r1", request: nil, info: nil)
        XCTAssertEqual(feed.standing(of: alert), .gone)
        XCTAssertEqual(feed.snapshots, 0)

        let pending = #"[{"requestId":"r1","ts":"2026-10-26T10:03:00.000Z","blob":"\#(AgentBlobs.request)"}]"#
        let asking = session("a", "permission", at: 4, pending: pending)
        try feed.apply(message(#"{"t":"snapshot","sessions":[\#(asking)],"machines":[]}"#), vault: vault)
        XCTAssertEqual(feed.snapshots, 1)
        XCTAssertEqual(feed.standing(of: alert), .pending)
        XCTAssertEqual(feed.standing(of: PermissionPush(sessionId: "a", requestId: "r2", request: nil, info: nil)), .gone)

        let offline = asking.replacingOccurrences(of: #""agentOnline":true"#, with: #""agentOnline":false"#)
        try feed.apply(message(#"{"t":"session","session":\#(offline)}"#), vault: vault)
        XCTAssertEqual(feed.standing(of: alert), .unreachable)

        try feed.apply(message(#"{"t":"session","session":\#(session("a", "working", at: 5))}"#), vault: vault)
        XCTAssertEqual(feed.standing(of: alert), .gone)
        try feed.apply(message(#"{"t":"snapshot","sessions":[],"machines":[]}"#), vault: vault)
        XCTAssertEqual(feed.snapshots, 2)
    }

    func testTheActionsOfAnAlert() {
        XCTAssertEqual(PermissionAction(rawValue: "allow"), .allow)
        XCTAssertEqual(PermissionAction(rawValue: "deny")?.allows, false)
        XCTAssertNil(PermissionAction(rawValue: UUID().uuidString), "a tap on the alert itself is no answer")
        XCTAssertEqual(PermissionAction.allCases.map(\.title), ["Allow", "Deny"])
    }

    func testConversationsAreKeptWithoutDuplicates() throws {
        let key = try E2E.key(fromBase64URL: E2E.newKey())
        let vault = SessionVault(key: key)
        func sealed(_ id: String, _ text: String) throws -> String {
            let blob = try E2E.seal(Entry(id: id, ts: "t", kind: .assistant, text: text), with: key)
            return #"{"id":"\#(id)","ts":"t","blob":"\#(blob)"}"#
        }
        var feed = RelayFeed()
        try feed.apply(message(#"{"t":"snapshot","sessions":[\#(session("a", "working", at: 0))],"machines":[]}"#), vault: vault)
        try feed.apply(message(#"{"t":"history","sessionId":"a","entries":[\#(try sealed("e1", "Hello"))]}"#), vault: vault)
        try feed.apply(
            message(
                #"{"t":"entries","sessionId":"a","entries":[\#(try sealed("e1", "Hello")),\#(try sealed("e2", "Done"))],"reset":false}"#),
            vault: vault)
        XCTAssertEqual(feed.entries["a"]?.map(\.text), ["Hello", "Done"])
        // A new snapshot drops what belongs to sessions the relay forgot.
        try feed.apply(message(#"{"t":"snapshot","sessions":[],"machines":[]}"#), vault: vault)
        XCTAssertNil(feed.entries["a"])
    }

    func testTheListGroupsWhatNeedsTheUserFirst() {
        func summary(_ id: String, _ status: SessionStatus) -> SessionSummary {
            SessionSummary(
                id: id, machineId: "m", machine: "PC", platform: nil, cwd: "/", project: id, title: nil, status: status, statusText: nil,
                agentOnline: true, canChat: true, pendingPermissions: [], costUSD: nil, startedAt: .distantPast,
                lastActivity: .distantPast, lastMessage: nil)
        }
        let groups = SessionGroup.groups([summary("w", .working), summary("p", .permission), summary("e", .ended), summary("q", .waiting)])
        XCTAssertEqual(groups.map(\.kind), [.needsYou, .working, .closed])
        XCTAssertEqual(groups.first?.sessions.map(\.id), ["p", "q"])
        XCTAssertEqual(groups.first?.kind.title, "Needs you")
    }
}

final class PhoneLinkTests: XCTestCase {
    func testSessionLinksRoundTrip() throws {
        let url = try XCTUnwrap(PhoneLink.session("1b6f-42").url)
        XCTAssertEqual(url.absoluteString, "tonton://session/1b6f-42")
        XCTAssertEqual(PhoneLink(url: url), .session("1b6f-42"))
        XCTAssertNil(PhoneLink(url: try XCTUnwrap(URL(string: "tonton://session/"))))
        XCTAssertNil(PhoneLink(url: try XCTUnwrap(URL(string: "tonton://session/a/b"))))
        XCTAssertNil(PhoneLink(url: try XCTUnwrap(URL(string: "https://session/a"))))
    }
}

final class PhoneSignInTests: XCTestCase {
    /// The QR code of Settings › Machines holds the recovery key without the join secret, which the phone does not need.
    func testThePhoneSignsInWithTheRecoveryKeyWithOrWithoutTheJoinSecret() throws {
        let account = Account(relay: "https://tonton.d3l.tech", accountId: "acc", token: "ta_x", key: E2E.newKey(), joinSecret: "s")
        XCTAssertEqual(Account(recoveryKey: "  \(account.recoveryKey)\n"), account)
        XCTAssertEqual(Account(recoveryKey: account.with(joinSecret: nil).recoveryKey)?.joinSecret, nil)
        XCTAssertEqual(Account(recoveryKey: account.with(joinSecret: nil).recoveryKey)?.key, account.key)
        XCTAssertNil(Account(recoveryKey: "tonton_" + account.recoveryKey.dropFirst(8)), "an account token is not a recovery key")
    }
}
