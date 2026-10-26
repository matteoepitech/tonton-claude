import XCTest

@testable import TontonCore

/// Blobs sealed by agent/src/crypto.ts with a key of 32 bytes set to 42, like `E2ETests`.
enum AgentBlobs {
    static let key = "KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio"
    /// `{ machine: "PC-Test", platform: "win32", cwd: "C:\\code\\api", project: "api" }`
    static let info =
        "ViC91mbbJ59Xxik1xbvwAUpSkCMw+bC+jfHgtcUR4GWAvK+IeMd+jh6H4aGb9aoVjpBpei5YrVfisfKUdpfgjNumHb6T6VooQ8zt4rimwy2wWO/gYVmRZLeL6IaNSrj1wF8G185Edm0qlw=="
    /// `{ text: "Claude needs your permission to use Bash" }`
    static let detail =
        "hJ4jXK4t2AsFUfcDXO/PpU9dmJzW4Hfmhh1kD36TVbFszAYU5ouhgGaZyuYgZ+L4uUcM/3nJaSptE+7i4L+n4Qhh+WRK4ZnDr5jnRpzivg=="
    /// `{ toolName: "Bash", description: "Run the tests", inputPreview: '{"command":"npm test"}' }`
    static let request =
        "1BAWQNgI2Cn7d9qt4oH+j5z87sNXZm0SBBPWigKuamX5SQabShj2P5vr39uxXOgYNuYe+RfnErWSFxDldDsygcGmKPAg/nW7Pvo0XRlCpgdpIS2iH0N5ydXd2H0/ngXiQP3rMceRNXwcWFdir0QxvrkeizsxeUktQA=="

    static func vault() throws -> SessionVault { SessionVault(key: try E2E.key(fromBase64URL: key)) }
}

final class IslandTests: XCTestCase {
    private func wire(_ id: String, _ status: String, at minute: Int, info: String? = nil, detail: String? = nil) throws -> WireSession {
        let json: [String: Any] = [
            "id": id, "machineId": "m1", "status": status, "agentOnline": true, "canChat": true, "info": info ?? NSNull(),
            "meta": NSNull(), "statusDetail": detail ?? NSNull(), "pendingPermissions": [],
            "startedAt": "2026-10-26T10:00:00.000Z", "lastActivity": String(format: "2026-10-26T10:%02d:00.000Z", minute),
        ]
        return try JSONDecoder().decode(WireSession.self, from: JSONSerialization.data(withJSONObject: json))
    }

    func testBuiltLikeTheRelayBuildsIt() throws {
        let state = IslandState([
            try wire("done", "idle", at: 9), try wire("old-work", "working", at: 1), try wire("new-work", "working", at: 5),
            try wire("asks", "permission", at: 0, info: "info"), try wire("gone", "ended", at: 10), try wire("away", "offline", at: 10),
        ])
        XCTAssertEqual(state.sessions.map(\.id), ["asks", "new-work", "old-work"])
        XCTAssertEqual(state.working, 2)
        XCTAssertEqual(state.attention, 1)
        XCTAssertEqual(state.sessions.first, IslandState.Session(id: "asks", status: .permission, info: "info", detail: nil))
        XCTAssertTrue(state.isActive)
        XCTAssertEqual(state.status, .permission)
        XCTAssertFalse(IslandState([try wire("done", "idle", at: 0)]).isActive)
    }

    func testBlobsTooLongToPushAreLeftOut() throws {
        let state = IslandState([try wire("a", "waiting", at: 0, info: String(repeating: "x", count: 2000), detail: "d")])
        XCTAssertEqual(state.sessions.first?.info, nil)
        XCTAssertEqual(state.sessions.first?.detail, "d")
    }

    /// The content state exactly as relay/src/push.ts pushes it.
    func testDecodesWhatTheRelayPushesAndOpensIt() throws {
        let json = """
            {"sessions":[{"id":"s1","status":"permission","info":"\(AgentBlobs.info)","detail":"\(AgentBlobs.detail)"},
            {"id":"s2","status":"working","info":null,"detail":null},{"id":"s3","status":"idle","info":"bm9wZQ==","detail":null}],
            "working":1,"attention":1}
            """
        let state = try JSONDecoder().decode(IslandState.self, from: Data(json.utf8))
        let lines = try AgentBlobs.vault().lines(state)
        XCTAssertEqual(
            lines.first, IslandLine(id: "s1", status: .permission, project: "api", machine: "PC-Test", text: "Wants to use Bash"))
        XCTAssertEqual(lines[1], IslandLine(id: "s2", status: .working, project: "Session", machine: nil, text: "Working"))
        XCTAssertEqual(lines[2].project, "Session", "a blob that does not open shows a placeholder")
        let other = SessionVault(key: try E2E.key(fromBase64URL: E2E.newKey()))
        XCTAssertEqual(other.lines(state).first?.project, "Session")
    }

    func testTheStateRoundTripsThroughJSON() throws {
        let state = IslandState(sessions: [.init(id: "a", status: .error, info: nil, detail: "x")], working: 0, attention: 1)
        XCTAssertEqual(try JSONDecoder().decode(IslandState.self, from: JSONEncoder().encode(state)), state)
    }
}

final class PushTests: XCTestCase {
    private func userInfo(_ tonton: [String: Any]) -> [AnyHashable: Any] {
        ["aps": ["alert": ["title": "Permission request"]], "tonton": tonton]
    }

    func testAPermissionAlertOpensIntoItsRealText() throws {
        let push = try XCTUnwrap(
            PermissionPush(
                userInfo: userInfo(["sessionId": "s1", "requestId": "r1", "request": AgentBlobs.request, "info": AgentBlobs.info])))
        let alert = try XCTUnwrap(try AgentBlobs.vault().alert(for: push))
        XCTAssertEqual(alert.title, "api")
        XCTAssertEqual(alert.subtitle, "PC-Test")
        XCTAssertEqual(alert.body, "Allow Bash? Run the tests\n{\"command\":\"npm test\"}")
        XCTAssertEqual(alert.request?.requestId, "r1")
        XCTAssertEqual(alert.request?.toolName, "Bash")
    }

    func testWhatDoesNotOpenKeepsTheGenericText() throws {
        let bare = try XCTUnwrap(PermissionPush(userInfo: userInfo(["sessionId": "s1", "requestId": "r1"])))
        XCTAssertNil(try AgentBlobs.vault().alert(for: bare))
        let foreign = SessionVault(key: try E2E.key(fromBase64URL: E2E.newKey()))
        let sealed = try XCTUnwrap(
            PermissionPush(userInfo: userInfo(["sessionId": "s1", "requestId": "r1", "request": AgentBlobs.request])))
        XCTAssertNil(foreign.alert(for: sealed))
        let sessionOnly = try XCTUnwrap(
            PermissionPush(userInfo: userInfo(["sessionId": "s1", "requestId": "r1", "info": AgentBlobs.info])))
        XCTAssertEqual(try AgentBlobs.vault().alert(for: sessionOnly)?.body, "Asks for a permission.")
    }

    func testOtherNotificationsAreNotPermissionPushes() {
        XCTAssertNil(PermissionPush(userInfo: ["aps": ["alert": "hi"]]))
        XCTAssertNil(PermissionPush(userInfo: ["tonton": ["sessionId": "s1"]]))
        XCTAssertNil(PermissionPush(userInfo: ["tonton": "nope"]))
    }
}
