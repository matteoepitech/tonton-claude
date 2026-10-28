import CryptoKit
import XCTest

@testable import TontonCore

final class PoolStateTests: XCTestCase {
    private let poolId = "pool00000001"
    private let vault = SessionVault(key: SymmetricKey(size: .bits256))

    private func item(_ id: String, rev: Int = 1, _ blob: String, by account: String = "ana", session: String? = "ses_ana") -> PoolItemWire
    {
        PoolItemWire(
            id: id, rev: rev, seq: rev, updatedAt: "2026-10-27T10:00:00Z", ts: "2026-10-27T10:00:00Z", account: account, session: session,
            blob: blob)
    }

    private func task(_ title: String, _ state: PoolTaskState, to session: String?, area: String? = nil) -> PoolTask {
        PoolTask(
            title: title, goal: nil, criteria: nil, area: area, state: state,
            assignee: session.map { PoolSessionRef(account: "me", session: $0) },
            dependsOn: nil, branch: nil, summary: nil)
    }

    private func snapshot(
        _ pool: PoolVault, tasks: [PoolItemWire] = [], messages: [PoolItemWire] = [], own: PoolOwnKeys? = nil,
        members: [PoolMemberWire]? = nil
    )
        throws -> PoolSnapshot
    {
        let everyone = [
            PoolMemberWire(account: "ana", role: .owner, joinedAt: "x", profile: try pool.seal(PoolMemberProfile(name: "Ana"))),
            PoolMemberWire(account: "me", role: .member, joinedAt: "x", profile: try pool.seal(PoolMemberProfile(name: "Me"))),
        ]
        return PoolSnapshot(
            id: poolId, createdAt: "2026-10-27T09:00:00Z", paused: false, keyVersion: pool.keyring.version,
            info: try pool.seal(PoolInfo(name: "Hackathon", goal: "Ship the app")),
            members: members ?? everyone,
            sessions: [
                PoolSessionWire(
                    account: "ana", session: "ses_ana", joinedAt: "x", profile: try pool.seal(PoolSessionProfile()),
                    online: true, ready: true, accepted: nil),
                PoolSessionWire(
                    account: "me", session: "ses_me", joinedAt: "x", profile: try pool.seal(PoolSessionProfile(area: "front")),
                    online: true,
                    ready: true, accepted: nil),
            ],
            tasks: tasks, notes: nil, messages: messages, events: [], own: own, rules: nil, budgets: nil, audit: nil,
            orchestrator: PoolSessionRef(account: "ana", session: "ses_ana"))
    }

    func testWhatASessionWorksOnWaitsForAndHears() throws {
        let pool = try PoolVault(key: E2E.newKey())
        let tasks = [
            item("t1", try pool.seal(task("Login page", .assigned, to: "ses_me"))),
            item("t2", try pool.seal(task("API client", .inProgress, to: "ses_me"))),
            item("t3", try pool.seal(task("Backend", .inProgress, to: "ses_ana"))),
            item("t4", try pool.seal(task("Docs", .done, to: "ses_me"))),
            item("t5", "not a blob"),
        ]
        let message = { (text: String, to: PoolMessageBody.Target?) in try pool.seal(PoolMessageBody(text: text, to: to)) }
        let messages = [
            item("m1", rev: 1, try message("Everyone: contracts are in the notes", nil)),
            item("m2", rev: 2, try message("Front: use /v1", PoolMessageBody.Target(session: nil, area: "front"))),
            item("m3", rev: 3, try message("Back only", PoolMessageBody.Target(session: nil, area: "back"))),
            item(
                "m4", rev: 4,
                try message(
                    "For another session", PoolMessageBody.Target(session: PoolSessionRef(account: "ana", session: "ses_ana"), area: nil))),
            item(
                "m5", rev: 5,
                try message("Sent by me", PoolMessageBody.Target(session: PoolSessionRef(account: "ana", session: "ses_ana"), area: nil)),
                by: "me", session: "ses_me"),
        ]
        let state = PoolState(snapshot: try snapshot(pool, tasks: tasks, messages: messages), vault: pool)
        XCTAssertEqual(state.info?.name, "Hackathon")
        XCTAssertEqual(state.currentTask(of: "ses_me")?.task?.title, "API client")
        XCTAssertEqual(state.waitingTasks(of: "ses_me").map(\.id), ["t1"])
        XCTAssertNil(state.tasks.first { $0.id == "t5" }?.task)
        XCTAssertEqual(
            state.messages(of: "ses_me").compactMap(\.body?.text), ["Everyone: contracts are in the notes", "Front: use /v1", "Sent by me"])
        XCTAssertEqual(state.who(account: "ana", session: "ses_ana"), "Ana · orchestrator")
        XCTAssertEqual(state.who(account: "me", session: "ses_me"), "Me · front")
        XCTAssertEqual(state.who(account: "ana", session: nil), "Ana")
        let refused = PoolState.refused(try XCTUnwrap(state.waitingTasks(of: "ses_me").first?.task))
        XCTAssertEqual(refused.state, .todo)
        XCTAssertNil(refused.assignee)
        XCTAssertEqual(refused.title, "Login page")
    }

    func testChangesFoldInAndARemovedPoolIsGone() throws {
        let pool = try PoolVault(key: E2E.newKey())
        var state = PoolState(snapshot: try snapshot(pool), vault: pool)
        XCTAssertTrue(state.apply(.task(poolId: poolId, item("t1", try pool.seal(task("Login", .assigned, to: "ses_me")))), vault: pool))
        XCTAssertTrue(
            state.apply(.task(poolId: poolId, item("t1", rev: 2, try pool.seal(task("Login", .inProgress, to: "ses_me")))), vault: pool))
        XCTAssertEqual(state.tasks.count, 1)
        XCTAssertEqual(state.currentTask(of: "ses_me")?.task?.state, .inProgress)
        XCTAssertTrue(state.apply(.sessionLeft(poolId: poolId, account: "me", session: "ses_me"), vault: pool))
        XCTAssertNil(state.session("ses_me"))
        XCTAssertTrue(
            state.apply(.info(poolId: poolId, info: try pool.seal(PoolInfo(name: "Renamed")), paused: true, keyVersion: 1), vault: pool))
        XCTAssertEqual(state.info?.name, "Renamed")
        XCTAssertTrue(state.paused)
        XCTAssertFalse(state.apply(.removed(poolId: poolId), vault: pool))
        XCTAssertEqual(PoolState.poolId(of: .removed(poolId: poolId)), poolId)
    }

    func testABoardOpensTheKeysRotatedForItsMember() throws {
        let v1 = E2E.newKey()
        let v2 = E2E.newKey()
        var keyring = PoolKeyring(key: v1)
        // This member's key pair, and the admin's who rotated the key to version 2.
        let mine = try vault.newPoolMemberKeys(poolId: poolId, account: "me", keyring: keyring)
        let minePublic = try XCTUnwrap(vault.poolMemberSecret(mine.secret, poolId: poolId)).publicKey
        let admin = PoolMemberSecret(poolId: poolId, privateKey: P256.KeyAgreement.PrivateKey())
        let adminKey = try keyring.seal(PoolMemberKey(poolId: poolId, account: "ana", key: admin.publicKey))
        let wrap = try PoolKeys.wrap(
            PoolKeyWrap(poolId: poolId, version: 2, key: v2, from: "ana", to: "me"), admin: admin, memberPublic: minePublic)
        keyring.add(version: 2, key: v2)
        let pool = PoolVault(keyring: keyring)
        let members = [
            PoolMemberWire(
                account: "ana", role: .owner, joinedAt: "x", profile: try pool.seal(PoolMemberProfile(name: "Ana")), publicKeys: [adminKey]),
            PoolMemberWire(account: "me", role: .member, joinedAt: "x", profile: nil, publicKeys: [mine.publicKey]),
        ]
        let summary = try JSONDecoder().decode(
            PoolSummary.self,
            from: JSONSerialization.data(withJSONObject: [
                "id": poolId, "role": "member", "createdAt": "x", "paused": false, "keyVersion": 2,
                "info": try PoolVault(key: v1).seal(PoolInfo(name: "Hackathon")),
                "key": try vault.sealPoolKeyGrant(poolId: poolId, key: v1, version: 1),
                "members": 2, "secret": mine.secret, "wraps": [],
            ]))
        var board = try XCTUnwrap(PoolBoard(summary: summary, vault: vault))
        XCTAssertEqual(board.name, "Hackathon")
        let sealedTask = try pool.seal(task("After the rotation", .assigned, to: "ses_me"))
        XCTAssertTrue(sealedTask.hasPrefix("2:"))
        let own = PoolOwnKeys(secret: mine.secret, wraps: [PoolKeyWrapWire(version: 2, from: "ana", blob: wrap)])
        XCTAssertTrue(
            board.take(
                .snapshot(try snapshot(pool, tasks: [item("t1", sealedTask)], own: own, members: members)), account: "me", vault: vault))
        XCTAssertEqual(board.keyring.versions, [1, 2])
        XCTAssertEqual(board.state?.waitingTasks(of: "ses_me").first?.task?.title, "After the rotation")
        XCTAssertFalse(board.take(.removed(poolId: poolId), account: "me", vault: vault))
        // A copy of the key that does not open with this account key is no pool of this member.
        XCTAssertNil(PoolBoard(summary: summary, vault: SessionVault(key: try E2E.key(fromBase64URL: E2E.newKey()))))
    }

    func testJoiningTakesTheToolsKindOfTaskAndStartsItsTasks() {
        let claude = SessionSummary.preview(tool: nil)
        let opencode = SessionSummary.preview(tool: "opencode")
        XCTAssertEqual(PoolJoinForm(session: claude).takes, .large)
        XCTAssertEqual(PoolJoinForm(session: opencode).takes, .simple)
        // It starts what the pool gives it unless its owner says otherwise: permission prompts still come to them.
        XCTAssertTrue(PoolJoinForm(session: claude).autoStart)
        var form = PoolJoinForm(session: opencode)
        form.area = "  Front "
        form.skills = ""
        let profile = form.profile(for: opencode)
        XCTAssertEqual(profile.area, "front")
        XCTAssertNil(profile.skills)
        XCTAssertEqual(profile.tool, "opencode")
        XCTAssertEqual(profile.takes, "simple")
        XCTAssertEqual(profile.repo, opencode.cwd)
        XCTAssertEqual(PoolTaskSize.of(profile, tool: .openCode), .simple)
        XCTAssertEqual(PoolTaskSize.of(PoolSessionProfile(takes: "large"), tool: .openCode), .large)
        XCTAssertEqual(PoolTaskSize.of(nil, tool: .claudeCode), .large)
    }

    func testOnlyAgentsThatKnowPoolsAreOfferedToJoin() {
        let machine = { (version: String?) in
            MachineInfo(id: "m1", name: "PC", platform: nil, createdAt: Date(), lastSeen: nil, online: true, agentVersion: version)
        }
        XCTAssertEqual(["0.7.0", "0.8.0", "1.0.0", "0.0.0"].map { machine($0).joinsPools }, [false, true, true, true])
        XCTAssertFalse(machine(nil).joinsPools)
        XCTAssertEqual(
            PoolLinks.website(relay: "https://tonton.example.com/", pool: poolId)?.absoluteString,
            "https://tonton.example.com/#pool=\(poolId)")
    }
}

extension SessionSummary {
    fileprivate static func preview(tool: String?) -> SessionSummary {
        SessionSummary(
            id: "ses_1", machineId: "m1", machine: "PC", platform: "darwin", cwd: "/Users/me/code/shop", project: "shop", title: nil,
            status: .idle, statusText: nil, agentOnline: true, canChat: true, pendingPermissions: [], costUSD: nil, startedAt: Date(),
            lastActivity: Date(), lastMessage: nil, tool: tool)
    }
}
