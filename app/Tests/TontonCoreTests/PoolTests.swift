import XCTest

@testable import TontonCore

final class PoolTests: XCTestCase {
    private let token = "tp_abcdefghijkl_" + String(repeating: "t", count: 43)

    func testAnInviteGoesBackToWhatMadeItAndNothingElseIsOne() throws {
        let invite = PoolInvite(relay: "https://tonton.example.com", pool: "pool00000001", token: token, key: E2E.newKey(), version: 1)
        XCTAssertTrue(invite.string.hasPrefix("tontonpool1."))
        XCTAssertEqual(PoolInvite(string: " \(invite.string)\n"), invite)
        XCTAssertEqual(PoolInvite(string: "#\(invite.string)"), invite)
        let share = ShareLink(
            relay: "https://tonton.example.com", token: "ts_abcdefghijkl_" + String(repeating: "t", count: 43), key: E2E.newKey())
        XCTAssertNil(PoolInvite(string: share.string))
        XCTAssertNil(
            PoolInvite(string: PoolInvite(relay: "https://x.y", pool: "short", token: token, key: E2E.newKey(), version: 1).string))
        XCTAssertNil(
            PoolInvite(string: PoolInvite(relay: "https://x.y", pool: "pool00000001", token: "ta_x", key: E2E.newKey(), version: 1).string))
        XCTAssertNil(
            PoolInvite(string: PoolInvite(relay: "ftp://x.y", pool: "pool00000001", token: token, key: E2E.newKey(), version: 1).string))
    }

    func testTheKeyGrantOpensWithTheAccountKeyForItsPoolOnly() throws {
        let vault = SessionVault(key: try E2E.key(fromBase64URL: E2E.newKey()))
        let poolKey = E2E.newKey()
        let grant = try vault.sealPoolKeyGrant(poolId: "pool00000001", key: poolKey, version: 3)
        XCTAssertEqual(vault.poolKey(from: grant, poolId: "pool00000001")?.key, poolKey)
        XCTAssertEqual(vault.poolKey(from: grant, poolId: "pool00000001")?.version, 3)
        XCTAssertNil(vault.poolKey(from: grant, poolId: "pool00000002"))
        XCTAssertNil(SessionVault(key: try E2E.key(fromBase64URL: E2E.newKey())).poolKey(from: grant, poolId: "pool00000001"))
    }

    func testPoolMessagesDecodeAsTheRelaySendsThem() throws {
        let decode = { (json: String) in try JSONDecoder().decode(RelayMessage.self, from: Data(json.utf8)) }
        let task =
            #"{"t":"pool_task","poolId":"pool00000001","task":{"id":"task0001","rev":2,"updatedAt":"2026-10-27T10:00:00.000Z","account":"acct","session":null,"blob":"sealed"}}"#
        guard case .pool(.task(let poolId, let item)) = try decode(task) else { return XCTFail("not a task") }
        XCTAssertEqual(poolId, "pool00000001")
        XCTAssertEqual(item.rev, 2)
        XCTAssertNil(item.session)
        let snapshot = #"""
            {"t":"pool_snapshot","pool":{"id":"pool00000001","createdAt":"x","paused":false,"keyVersion":1,"info":"sealed",
            "members":[{"account":"acct","role":"owner","joinedAt":"x","profile":null}],
            "sessions":[{"account":"acct","session":"ses_1","joinedAt":"x","profile":"sealed","online":true,"ready":false}],
            "tasks":[],"notes":null,"messages":[{"id":"m1","seq":4,"ts":"x","account":"acct","session":"ses_1","blob":"sealed"}],"events":[]}}
            """#
        guard case .pool(.snapshot(let pool)) = try decode(snapshot) else { return XCTFail("not a snapshot") }
        XCTAssertEqual(pool.members.first?.role, .owner)
        XCTAssertEqual(pool.sessions.first?.online, true)
        XCTAssertEqual(pool.messages.first?.seq, 4)
        guard case .pool(.removed("pool00000001")) = try decode(#"{"t":"pool_removed","poolId":"pool00000001"}"#) else {
            return XCTFail("not removed")
        }
        // A pool message the app cannot read, or a new kind, is ignored like any unknown message.
        guard case .unknown = try decode(#"{"t":"pool_task","poolId":"p","task":{"rev":"two"}}"#) else { return XCTFail("decoded") }
        guard case .unknown = try decode(#"{"t":"pool_future","poolId":"p"}"#) else { return XCTFail("decoded") }
    }

    func testPoolBlobsOpenWithThePoolKeyAndOnlyIt() throws {
        let poolKey = E2E.newKey()
        let vault = try PoolVault(key: poolKey)
        let task = PoolTask(
            title: "API", goal: nil, criteria: ["tests pass"], area: "back", state: .inProgress, assignee: nil, dependsOn: nil,
            branch: "feat/api", summary: nil)
        let sealed = try vault.seal(task)
        XCTAssertEqual(vault.open(sealed, as: PoolTask.self), task)
        XCTAssertNil(try PoolVault(key: E2E.newKey()).open(sealed, as: PoolTask.self))
        // The state goes over the wire as the client core writes it.
        let plaintext = String(decoding: try E2E.plaintext(sealed, with: try E2E.key(fromBase64URL: poolKey)), as: UTF8.self)
        XCTAssertTrue(plaintext.contains(#""state":"in_progress""#))
    }

    func testTheOrderCarriesTheOwnersChoiceAndSessionEventsTheirToolAndModel() throws {
        let accountKey = try E2E.key(fromBase64URL: E2E.newKey())
        let vault = SessionVault(key: accountKey)
        let poolKey = E2E.newKey()
        let asks = try vault.sealPoolSessionOrder(poolId: "pool12345678", sessionId: "ses_1", key: poolKey, version: 1)
        XCTAssertNil(try E2E.open(asks, as: PoolSessionOrder.self, with: accountKey).autoStart)
        let starts = try vault.sealPoolSessionOrder(poolId: "pool12345678", sessionId: "ses_1", key: poolKey, version: 1, autoStart: true)
        XCTAssertEqual(try E2E.open(starts, as: PoolSessionOrder.self, with: accountKey).autoStart, true)
        let event = try JSONDecoder().decode(PoolEventBody.self, from: Data(#"{"kind":"session","tool":"opencode","model":"gpt-5"}"#.utf8))
        XCTAssertEqual([event.kind, event.tool, event.model], ["session", "opencode", "gpt-5"])
    }

    func testUsageEventsAndSessionStatusReadAsTheAgentAndTheRelaySendThem() throws {
        let json =
            #"{"kind":"usage","usage":{"tokens":{"input":120000,"output":4000},"fiveHour":{"usedPercent":42,"resetsAt":"2026-10-27T18:00:00.000Z"}}}"#
        let event = try JSONDecoder().decode(PoolEventBody.self, from: Data(json.utf8))
        XCTAssertEqual(event.usage?.tokens, PoolUsage.Tokens(input: 120_000, output: 4000))
        XCTAssertEqual(event.usage?.fiveHour?.usedPercent, 42)
        XCTAssertNil(event.usage?.sevenDay)
        let session =
            #"{"account":"acc","session":"ses_1","joinedAt":"2026-10-27T10:00:00Z","profile":null,"online":true,"ready":true,"status":"working"}"#
        XCTAssertEqual(try JSONDecoder().decode(PoolSessionWire.self, from: Data(session.utf8)).status, "working")
        // Older relays send no status.
        let older = #"{"account":"acc","session":"ses_1","joinedAt":"2026-10-27T10:00:00Z","profile":null,"online":false,"ready":false}"#
        XCTAssertNil(try JSONDecoder().decode(PoolSessionWire.self, from: Data(older.utf8)).status)
    }

    func testTheOrchestratorAndTheStructuredNotesDecodeAsTheClientCoreWritesThem() throws {
        let decode = { (json: String) in try JSONDecoder().decode(RelayMessage.self, from: Data(json.utf8)) }
        let set = #"{"t":"pool_orchestrator","poolId":"pool00000001","orchestrator":{"account":"acct","session":"ses_1"}}"#
        guard case .pool(.orchestrator("pool00000001", let lead, nil)) = try decode(set) else { return XCTFail("not an orchestrator") }
        XCTAssertEqual(lead, PoolSessionRef(account: "acct", session: "ses_1"))
        guard case .pool(.orchestrator(_, nil, nil)) = try decode(#"{"t":"pool_orchestrator","poolId":"p","orchestrator":null}"#) else {
            return XCTFail("not none")
        }
        let snapshot = #"""
            {"t":"pool_snapshot","pool":{"id":"pool00000001","createdAt":"x","paused":false,"keyVersion":1,"info":"sealed",
            "members":[],"sessions":[],"tasks":[],"notes":null,"messages":[],"events":[],
            "orchestrator":{"account":"acct","session":"ses_1"}}}
            """#
        guard case .pool(.snapshot(let pool)) = try decode(snapshot) else { return XCTFail("not a snapshot") }
        XCTAssertEqual(pool.orchestrator?.session, "ses_1")

        // What shared/pool.ts seals for the notes, a task and a profile.
        let vault = try PoolVault(key: E2E.newKey())
        let notes = #"{"text":"","sections":{"goal":"A shop","contracts":"GET /v1/items"},"areas":[{"name":"front","paths":["web/"]}]}"#
        let opened = try JSONDecoder().decode(PoolNotes.self, from: Data(notes.utf8))
        XCTAssertEqual(opened.sections?["contracts"], "GET /v1/items")
        XCTAssertEqual(opened.areas, [PoolArea(name: "front", paths: ["web/"])])
        XCTAssertEqual(vault.open(try vault.seal(opened), as: PoolNotes.self), opened)
        let task = try JSONDecoder().decode(
            PoolTask.self, from: Data(#"{"title":"Page","state":"assigned","size":"small","paths":["web/"],"branch":"pool/abc-page"}"#.utf8)
        )
        XCTAssertEqual([task.size, task.branch], ["small", "pool/abc-page"])
        let profile = try JSONDecoder().decode(PoolSessionProfile.self, from: Data(#"{"tool":"opencode","takes":"any"}"#.utf8))
        XCTAssertEqual(profile.takes, "any")
    }

    func testLimitsAndReviewReadAsTheAgentSealsThem() throws {
        let event =
            #"{"kind":"limits","limits":{"fiveHour":{"usedPercent":42.5,"resetsAt":"2026-10-27T14:00:00Z"},"runsOutAt":"2026-10-27T12:00:00Z"}}"#
        let body = try JSONDecoder().decode(PoolEventBody.self, from: Data(event.utf8))
        XCTAssertEqual(body.limits?.fiveHour, PoolLimitWindow(usedPercent: 42.5, resetsAt: "2026-10-27T14:00:00Z"))
        XCTAssertEqual(body.limits?.runsOutAt, "2026-10-27T12:00:00Z")
        XCTAssertNil(body.limits?.sevenDay)
        let task =
            #"{"title":"Checkout","state":"review","hours":2,"reviewer":{"account":"acc_rev","session":"rev"},"review":"Fix the total"}"#
        let decoded = try JSONDecoder().decode(PoolTask.self, from: Data(task.utf8))
        XCTAssertEqual(decoded.state, .review)
        XCTAssertEqual(decoded.hours, 2)
        XCTAssertEqual(decoded.reviewer?.session, "rev")
        XCTAssertEqual(decoded.review, "Fix the total")
    }

    func testMergeRecordReadsAsTheAgentSealsItAndIsKeptWhenWrittenBack() throws {
        let task =
            #"{"title":"Checkout","state":"assigned","merge":{"state":"conflict","at":"2026-10-28T12:00:00Z","files":["web/app.ts"],"output":"CONFLICT (content)","fix":"t2"}}"#
        let decoded = try JSONDecoder().decode(PoolTask.self, from: Data(task.utf8))
        XCTAssertEqual(decoded.merge?.state, "conflict")
        XCTAssertEqual(decoded.merge?.files, ["web/app.ts"])
        XCTAssertEqual(decoded.merge?.fix, "t2")
        let again = try JSONDecoder().decode(PoolTask.self, from: JSONEncoder().encode(decoded))
        XCTAssertEqual(again.merge, decoded.merge)
        // A newer agent's state, or a record with fields missing, still opens.
        let newer = try JSONDecoder().decode(PoolTask.self, from: Data(#"{"title":"T","state":"done","merge":{"state":"queued"}}"#.utf8))
        XCTAssertEqual(newer.merge?.state, "queued")
    }
}
