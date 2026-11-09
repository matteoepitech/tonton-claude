import XCTest

@testable import TontonCore

/// What the notch shows of a cluster (ClusterModel.swift), as web/test/clusters.test.ts checks it for the website: the
/// roster, the lines of a post, the claims, the clock and what the owner chooses for each session.
final class ClusterModelTests: XCTestCase {
    private func session(
        _ account: String, _ id: String, machine: String? = nil, status: String? = "working", online: Bool = true, ready: Bool = true,
        profile: ClusterSessionProfile? = nil
    ) -> ClusterState.Session {
        ClusterState.Session(
            account: account, session: id, machine: machine, joinedAt: "2026-11-04T10:00:00Z", profile: profile, online: online,
            ready: ready,
            status: status)
    }

    private func member(_ account: String, _ name: String?, role: ClusterRole = .member) -> ClusterState.Member {
        ClusterState.Member(
            account: account, role: role, joinedAt: "2026-11-04T10:00:00Z", profile: name.map(ClusterMemberProfile.init), publicKeys: [])
    }

    private func post(_ id: String, _ body: ClusterPostBody?, account: String = "bob", session: String? = "s1") -> ClusterState.Post {
        ClusterState.Post(id: id, seq: 0, ts: "2026-11-04T10:00:00Z", account: account, session: session, machine: nil, body: body)
    }

    private func state(
        members: [ClusterState.Member], sessions: [ClusterState.Session] = [], posts: [ClusterState.Post] = []
    ) -> ClusterState {
        ClusterState(
            id: "clus00000001", createdAt: "t", keyVersion: 1, info: ClusterInfo(name: "Jam"), members: members, sessions: sessions,
            posts: posts, docs: [], own: PoolOwnKeys(secret: nil, wraps: []))
    }

    func testTheRosterPutsThisAccountFirstThenTheOwnerAndBusySessionsFirst() {
        let state = state(
            members: [member("zed", "Zed"), member("alice", "Alice", role: .owner), member("me", "Val"), member("bob", nil)],
            sessions: [
                session("alice", "a1", machine: "m2", status: "idle", profile: ClusterSessionProfile(name: "level", machine: "Studio")),
                session(
                    "alice", "a2", machine: "m2", status: "permission", profile: ClusterSessionProfile(project: "hero", machine: "Studio")),
                session("alice", "a3", machine: "m1", profile: ClusterSessionProfile(name: "  ", machine: "Laptop")),
                session("me", "s1", status: nil),
            ])
        let roster = ClusterModel.roster(state, account: "me")
        XCTAssertEqual(roster.map(\.account), ["me", "alice", "bob", "zed"], "a member without a name reads as A member, before Zed")
        XCTAssertEqual(roster.map(\.mine), [true, false, false, false])
        XCTAssertEqual(roster[2].name, "A member")
        let alice = roster[1]
        XCTAssertEqual(alice.machines.map(\.name), ["Laptop", "Studio"])
        XCTAssertEqual(alice.machines[1].sessions.map(\.session), ["a2", "a1"], "the one that needs approval first")
        XCTAssertEqual(alice.sessions, 3)
        XCTAssertEqual(ClusterModel.sessionName(alice.machines[0].sessions[0]), "A session")
        XCTAssertEqual(ClusterModel.sessionName(alice.machines[1].sessions[0]), "hero")
        // A session without a machine in its profile or from the relay is on "A machine".
        XCTAssertEqual(roster[0].machines.map(\.name), ["A machine"])
    }

    func testAProfileKeepsTheToolsItKnows() throws {
        func tool(_ value: String) throws -> String? {
            let json = try JSONDecoder().decode(ClusterJSON.self, from: Data(#"{"project":"jam","tool":"\#(value)"}"#.utf8))
            return ClusterSessionProfile(json: json)?.tool
        }
        XCTAssertEqual(try tool("claude"), "claude")
        XCTAssertEqual(try tool("opencode"), "opencode")
        XCTAssertEqual(try tool("codex"), "codex")
        XCTAssertNil(try tool("aider"))
    }

    func testTheRosterSaysWhatEachSessionIsDoing() {
        let profile = ClusterSessionProfile(
            project: "jam", machine: "Studio", tool: "opencode", model: "claude-opus-4-5-20251101", branch: "main", status: "rigging")
        XCTAssertEqual(ClusterModel.facts(profile), "jam · main · OpenCode · Opus 4.5")
        let codex = ClusterSessionProfile(project: "jam", tool: "codex", model: "gpt-5-codex")
        XCTAssertEqual(ClusterModel.facts(codex), "jam · Codex · gpt-5-codex")
        XCTAssertEqual(ClusterModel.facts(nil), "")
        XCTAssertEqual(ClusterModel.state(of: session("a", "s", online: false)), "Offline")
        XCTAssertEqual(ClusterModel.state(of: session("a", "s", ready: false)), "Waiting for its agent")
        XCTAssertEqual(ClusterModel.state(of: session("a", "s", status: "permission")), "Needs approval")
        XCTAssertEqual(ClusterModel.state(of: session("a", "s", status: "waiting")), "Waiting for its owner")
        XCTAssertEqual(ClusterModel.state(of: session("a", "s", status: "waiting"), mine: true), "Waiting for you")
        XCTAssertEqual(ClusterModel.status(of: session("a", "s", status: "working", online: false)), .offline)
        XCTAssertEqual(ClusterModel.status(of: session("a", "s", status: nil)), .idle)
    }

    func testAPostSaysWhoWroteItWhoItIsForAndWhatHappened() {
        let state = state(
            members: [member("alice", "Alice", role: .owner), member("bob", "Bob")],
            sessions: [session("bob", "s1", profile: ClusterSessionProfile(name: "rig", machine: "Box", tool: "claude"))])
        XCTAssertEqual(ClusterModel.author(state, account: "bob", session: "s1"), "Bob · Box · Claude Code")
        XCTAssertEqual(ClusterModel.author(state, account: "bob", session: "gone"), "Bob")
        XCTAssertEqual(ClusterModel.author(state, account: "alice", session: nil), "Alice")
        let to = ClusterPostBody(
            kind: .ask, text: "?", to: [ClusterTarget(account: "bob", session: "s1"), ClusterTarget(account: "alice")])
        XCTAssertEqual(ClusterModel.recipients(state, to), "rig (Bob), Alice")
        XCTAssertNil(ClusterModel.recipients(state, ClusterPostBody(kind: .message, text: "hi")), "nil: everyone")
        XCTAssertEqual(ClusterModel.eventLine(ClusterEvent(type: "submit", ok: true, ref: "CL 1234", count: 3)), "submit · CL 1234 · 3")
        XCTAssertEqual(ClusterModel.eventLine(ClusterEvent(type: "build", ok: false)), "build · failed")
        XCTAssertNil(ClusterModel.eventLine(nil))
        let file = ClusterFileRef(
            json: .object([
                "id": .string("f1"), "name": .string("hero.png"), "size": .number(12_800), "type": .string("image/png"),
                "sha256": .string(String(repeating: "a", count: 64)),
            ]))
        XCTAssertEqual(ClusterModel.fileLine(file), "hero.png · image/png · 13 KB")
        XCTAssertEqual(ClusterModel.kindLabel(.ask), "Question")
    }

    func testTheFeedIsNewestFirstAndFindsWhatAPostAnswers() {
        let ask = post("p1", ClusterPostBody(kind: .ask, text: "Which input jumps?"))
        let answer = post("p2", ClusterPostBody(kind: .answer, text: "Space", replyTo: "p1"))
        let event = post("p3", ClusterPostBody(kind: .event, text: "pushed", event: ClusterEvent(type: "push")))
        let sealed = post("p4", nil)
        let state = state(members: [member("bob", "Bob")], posts: [ask, answer, event, sealed])
        XCTAssertEqual(ClusterModel.feed(state).map(\.id), ["p4", "p3", "p2", "p1"])
        XCTAssertEqual(ClusterModel.feed(state, kind: .event).map(\.id), ["p3"])
        XCTAssertEqual(ClusterModel.replied(answer, in: state)?.id, "p1")
        XCTAssertNil(ClusterModel.replied(ask, in: state))
    }

    func testOnlyClaimsStillHeldAreShownNewestFirst() throws {
        let now = try XCTUnwrap(ClusterModel.date("2026-11-04T12:00:00Z"))
        let claims = [
            ClusterClaim(id: "old", paths: ["a"], account: "a", session: "s", at: "2026-11-04T09:00:00Z"),
            ClusterClaim(id: "lapsed", paths: ["b"], account: "a", session: "s", at: "2026-11-04T10:00:00Z", until: "2026-11-04T11:00:00Z"),
            ClusterClaim(
                id: "new", paths: ["c"], account: "a", session: "s", at: "2026-11-04T11:30:00.000Z", until: "2026-11-04T13:00:00Z"),
        ]
        XCTAssertEqual(ClusterModel.heldClaims(claims, now: now).map(\.id), ["new", "old"])
    }

    func testTheClockSaysWhatIsLeftAndWhatComesNext() throws {
        XCTAssertEqual(ClusterModel.timeLeft(0), "Time is up")
        XCTAssertEqual(ClusterModel.timeLeft(30), "Under a minute left")
        XCTAssertEqual(ClusterModel.timeLeft(12 * 60 + 5), "12 min left")
        XCTAssertEqual(ClusterModel.timeLeft(3 * 3600), "3 h left")
        XCTAssertEqual(ClusterModel.timeLeft(3 * 3600 + 5 * 60), "3 h 05 min left")
        XCTAssertEqual(ClusterModel.timeLeft(48 * 3600), "2 d left")
        XCTAssertEqual(ClusterModel.timeLeft(50 * 3600 + 59), "2 d 2 h left")

        let now = try XCTUnwrap(ClusterModel.date("2026-11-07T17:30:00Z"))
        let clock = ClusterModel.clock(
            ClusterClock(
                deadline: "2026-11-07T18:00:00.000Z",
                milestones: [
                    ClusterMilestone(name: "Gold", at: "2026-11-07T17:50:00Z"),
                    ClusterMilestone(name: "Art lock", at: "2026-11-07T12:00:00Z"),
                ]), now: now)
        XCTAssertEqual(clock.label, "30 min left")
        XCTAssertTrue(clock.lastHour)
        XCTAssertFalse(clock.ended)
        XCTAssertEqual(clock.marks.map(\.name), ["Art lock", "Gold"])
        XCTAssertEqual(clock.marks.map(\.passed), [true, false])
        XCTAssertEqual(clock.next?.name, "Gold")
        let after = ClusterModel.clock(ClusterClock(deadline: "2026-11-07T18:00:00Z"), now: now.addingTimeInterval(3600))
        XCTAssertEqual(after.label, "Time is up")
        XCTAssertTrue(after.ended)
        XCTAssertFalse(after.lastHour)
        XCTAssertNil(ClusterModel.clock(nil, now: now).label)
    }

    func testTheOwnersDraftBecomesTheClockEveryoneSees() throws {
        let now = try XCTUnwrap(ClusterModel.date("2026-11-07T10:00:00Z"))
        var draft = ClusterClockDraft(nil, now: now)
        XCTAssertFalse(draft.hasDeadline)
        XCTAssertNil(draft.clock(startedAt: nil, now: now).deadline)
        draft.hasDeadline = true
        draft = draft.adding(now: now).adding(now: now)
        XCTAssertEqual(draft.marks.count, 2)
        draft.marks[0].name = "  Playable build  "
        draft.marks[0].at = now.addingTimeInterval(7200)
        draft.marks[1].at = now.addingTimeInterval(3600)
        let clock = draft.clock(startedAt: "2026-11-07T09:00:00Z", now: now)
        XCTAssertEqual(clock.startedAt, "2026-11-07T09:00:00Z")
        XCTAssertEqual(clock.deadline, "2026-11-08T10:00:00.000Z")
        XCTAssertEqual(clock.milestones, [ClusterMilestone(name: "Playable build", at: "2026-11-07T12:00:00.000Z")], "no name: left out")
        // What was sealed reads back the same in the editor.
        let again = ClusterClockDraft(clock, now: now)
        XCTAssertEqual(again.marks.map(\.name), ["Playable build"])
        XCTAssertTrue(again.hasDeadline)
    }

    func testEachSessionsDeliveryIsRememberedPerCluster() {
        let choices = ClusterChoices()
        XCTAssertEqual(choices.choice(cluster: "c1", session: "s1"), .standard)
        XCTAssertEqual(ClusterSessionChoice.standard.delivery, .live)
        let next = choices.setting(ClusterSessionChoice(delivery: .digest), cluster: "c1", session: "s1")
            .setting(ClusterSessionChoice(delivery: .live, liveWithoutPrompts: true), cluster: "c2", session: "s1")
        XCTAssertEqual(choices.choice(cluster: "c1", session: "s1"), .standard, "the choices passed in are left as they were")
        let saved = ClusterChoices(data: next.data)
        XCTAssertEqual(saved.choice(cluster: "c1", session: "s1").delivery, .digest)
        XCTAssertTrue(saved.choice(cluster: "c2", session: "s1").liveWithoutPrompts)
        XCTAssertEqual(saved.without(cluster: "c1").choice(cluster: "c1", session: "s1"), .standard)
        XCTAssertEqual(ClusterChoices(data: Data("nope".utf8)), ClusterChoices())
        // Only live can be live without prompts.
        XCTAssertFalse(ClusterSessionChoice(delivery: .muted, liveWithoutPrompts: true).liveWithoutPrompts)
    }

    func testLiveTurnedIntoDigestsIsSaidWhenTheAgentSaysItSkipsPrompts() {
        let turned = ClusterSessionProfile(name: "rig", delivery: .digest, skipsPrompts: true)
        let live = ClusterSessionChoice.standard
        XCTAssertTrue(live.turnsDigest(turned))
        XCTAssertEqual(live.label(for: turned), "Live → digest: skips permission prompts")
        // Its owner chose a digest, or Live anyway, which its agent has not taken yet: nothing turned.
        XCTAssertFalse(ClusterSessionChoice(delivery: .digest).turnsDigest(turned))
        XCTAssertFalse(ClusterSessionChoice(delivery: .live, liveWithoutPrompts: true).turnsDigest(turned))
        XCTAssertEqual(ClusterSessionChoice(delivery: .live, liveWithoutPrompts: true).label(for: turned), "Live anyway")
        // It asks for permission, or an older agent says neither: the choice alone.
        XCTAssertFalse(live.turnsDigest(ClusterSessionProfile(name: "rig", delivery: .live)))
        XCTAssertFalse(live.turnsDigest(ClusterSessionProfile(name: "rig")))
        XCTAssertFalse(live.turnsDigest(nil))
        XCTAssertEqual(live.label(for: nil), "Live")
    }

    func testASessionShowsTheClusterItsNamesNeverItsPath() {
        let mine = SessionSummary(
            id: "s1", machineId: "m1", machine: "Studio", platform: "darwin", cwd: "/Users/val/Secret/jam", project: "jam", title: "Rig",
            status: .working, statusText: nil, agentOnline: true, canChat: true, pendingPermissions: [], costUSD: nil, startedAt: Date(),
            lastActivity: Date(), lastMessage: nil, model: "claude-opus-4-5", tool: "opencode", branch: "main")
        let profile = ClusterModel.profile(of: mine)
        XCTAssertEqual(
            profile,
            ClusterSessionProfile(
                name: "Rig", project: "jam", machine: "Studio", tool: "opencode", model: "claude-opus-4-5", branch: "main"))
        let codex = SessionSummary(
            id: "s3", machineId: "m1", machine: "Studio", platform: "darwin", cwd: "/x", project: "jam", title: nil, status: .working,
            statusText: nil, agentOnline: true, canChat: true, pendingPermissions: [], costUSD: nil, startedAt: Date(),
            lastActivity: Date(), lastMessage: nil, tool: "codex")
        XCTAssertEqual(ClusterModel.profile(of: codex).tool, "codex")
        let offline = SessionSummary(
            id: "s2", machineId: "m1", machine: "Studio", platform: nil, cwd: "/x", project: "x", title: nil, status: .idle,
            statusText: nil, agentOnline: false, canChat: false, pendingPermissions: [], costUSD: nil, startedAt: Date(),
            lastActivity: Date(),
            lastMessage: nil)
        let ended = SessionSummary(
            id: "s3", machineId: "m1", machine: "Studio", platform: nil, cwd: "/x", project: "x", title: nil, status: .ended,
            statusText: nil, agentOnline: true, canChat: false, pendingPermissions: [], costUSD: nil, startedAt: Date(),
            lastActivity: Date(),
            lastMessage: nil)
        let other = SessionSummary(
            id: "s4", machineId: "m1", machine: "Studio", platform: nil, cwd: "/x", project: "x", title: nil, status: .idle,
            statusText: nil, agentOnline: true, canChat: true, pendingPermissions: [], costUSD: nil, startedAt: Date(),
            lastActivity: Date(),
            lastMessage: nil)
        let state = state(members: [member("me", "Val")], sessions: [session("me", "s1")])
        XCTAssertEqual(ClusterModel.outside([mine, offline, ended, other], of: state, account: "me").map(\.id), ["s4"])
    }

    func testAgentsBeforeClustersAreNotOffered() {
        func machine(_ version: String?) -> MachineInfo {
            MachineInfo(id: "m", name: "Box", platform: nil, createdAt: Date(), lastSeen: nil, online: true, agentVersion: version)
        }
        XCTAssertFalse(machine("0.9.4").joinsClusters)
        XCTAssertFalse(machine(nil).joinsClusters)
        XCTAssertTrue(machine(MachineInfo.clustersSince).joinsClusters)
        XCTAssertTrue(machine("0.0.0").joinsClusters, "development builds run the current code")
    }
}
