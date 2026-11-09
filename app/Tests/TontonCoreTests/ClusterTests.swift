import CryptoKit
import XCTest

@testable import TontonCore

/// Clusters as the app reads them (docs/cluster.md), the same as shared/cluster.ts: invites, the order that puts a session
/// in, what another member sealed read leniently, and the state folded from the relay's messages.
final class ClusterTests: XCTestCase {
    private let clusterKey = String(repeating: "k", count: 42) + "A"

    func testAnInviteRoundTripsAndABadOneReadsAsNil() throws {
        let invite = ClusterInvite(
            relay: "https://relay.example.com", cluster: "clus00000001", token: "tc_abcdefghijkl_" + String(repeating: "t", count: 43),
            key: clusterKey, version: 2)
        XCTAssertEqual(ClusterInvite(string: invite.string), invite)
        XCTAssertEqual(ClusterInvite(string: "  \(invite.link)\n"), invite)
        XCTAssertTrue(invite.link.hasPrefix("https://relay.example.com/#tontoncluster1."))
        // A pool's invite, a pool's token, a short key or a bad relay are not a cluster's.
        let pool = PoolInvite(relay: invite.relay, pool: invite.cluster, token: invite.token, key: invite.key, version: 1)
        XCTAssertNil(ClusterInvite(string: pool.string))
        let tokens = ["tp_abcdefghijkl_" + String(repeating: "t", count: 43), "tc_short_x"]
        for token in tokens {
            XCTAssertNil(
                ClusterInvite(
                    string: ClusterInvite(relay: invite.relay, cluster: "clus00000001", token: token, key: clusterKey, version: 1).string))
        }
        XCTAssertNil(
            ClusterInvite(
                string: ClusterInvite(relay: "ftp://x", cluster: "clus00000001", token: invite.token, key: clusterKey, version: 1).string))
        XCTAssertNil(
            ClusterInvite(
                string: ClusterInvite(relay: invite.relay, cluster: "clus00000001", token: invite.token, key: "short", version: 1).string))
        XCTAssertNil(ClusterInvite(string: "tontoncluster1.!!!"))
    }

    func testAnOrderOpensOnlyForItsSessionItsClusterAndItsAccount() throws {
        let vault = SessionVault(key: try E2E.key(fromBase64URL: E2E.newKey()))
        let other = SessionVault(key: try E2E.key(fromBase64URL: E2E.newKey()))
        let sealed = try vault.sealClusterSessionOrder(
            clusterId: "clus00000001", sessionId: "s1", key: clusterKey, version: 1, delivery: .digest)
        let order = try XCTUnwrap(vault.openClusterSessionOrder(sealed, sessionId: "s1", clusterId: "clus00000001"))
        XCTAssertEqual(order.key, clusterKey)
        XCTAssertEqual(order.delivery, .digest)
        XCTAssertNil(order.liveWithoutPrompts)
        XCTAssertNil(vault.openClusterSessionOrder(sealed, sessionId: "s2", clusterId: "clus00000001"))
        XCTAssertNil(vault.openClusterSessionOrder(sealed, sessionId: "s1", clusterId: "clus00000002"))
        XCTAssertNil(other.openClusterSessionOrder(sealed, sessionId: "s1", clusterId: "clus00000001"))
        // A pool's order is not a cluster's.
        let poolOrder = try vault.sealPoolSessionOrder(poolId: "clus00000001", sessionId: "s1", key: clusterKey, version: 1)
        XCTAssertNil(vault.openClusterSessionOrder(poolOrder, sessionId: "s1", clusterId: "clus00000001"))
        // An unknown delivery reads as none rather than refusing the order.
        struct Odd: Encodable { let clusterId, sessionId, key, issuedAt, delivery: String; let version: Int }
        let odd = try E2E.seal(
            Odd(
                clusterId: "clus00000001", sessionId: "s1", key: clusterKey, issuedAt: "2026-11-04T10:00:00Z", delivery: "loud", version: 1),
            with: vault.key)
        XCTAssertNil(try XCTUnwrap(vault.openClusterSessionOrder(odd, sessionId: "s1", clusterId: "clus00000001")).delivery)
        let grant = try vault.sealClusterKeyGrant(clusterId: "clus00000001", key: clusterKey, version: 3)
        XCTAssertEqual(vault.clusterKey(from: grant, clusterId: "clus00000001")?.version, 3)
        XCTAssertNil(vault.clusterKey(from: grant, clusterId: "clus00000002"))
    }

    func testDeliveryIsLiveByDefaultAndADigestForASessionThatSkipsPrompts() {
        func order(_ delivery: ClusterDelivery?, live: Bool? = nil) -> ClusterSessionOrder {
            ClusterSessionOrder(
                clusterId: "c", sessionId: "s", key: clusterKey, version: 1, issuedAt: "", delivery: delivery, liveWithoutPrompts: live)
        }
        XCTAssertEqual(ClusterDelivery.of(order(nil), skipsPrompts: false), .live)
        XCTAssertEqual(ClusterDelivery.of(order(nil), skipsPrompts: true), .digest)
        XCTAssertEqual(ClusterDelivery.of(order(.live), skipsPrompts: true), .digest)
        XCTAssertEqual(ClusterDelivery.of(order(.live, live: true), skipsPrompts: true), .live)
        XCTAssertEqual(ClusterDelivery.of(order(.muted), skipsPrompts: true), .muted)
        XCTAssertEqual(ClusterDelivery.of(order(.digest), skipsPrompts: false), .digest)
    }

    func testWhatAnotherMemberSealedIsReadFieldByField() throws {
        let vault = try ClusterVault(key: clusterKey)
        func read<T: ClusterPayload>(_ object: [String: Any], as type: T.Type) throws -> T? {
            T(json: try JSONDecoder().decode(ClusterJSON.self, from: try JSONSerialization.data(withJSONObject: object)))
        }
        // An unknown kind, or no text, is not a post.
        XCTAssertNil(try read(["kind": "shout", "text": "x"], as: ClusterPostBody.self))
        XCTAssertNil(try read(["kind": "message"], as: ClusterPostBody.self))
        let body = try XCTUnwrap(
            try read(
                [
                    "kind": "ask", "text": "Which input action jumps?", "to": [["account": "bob"], ["session": "no account"], 3],
                    "topic": 42, "replyTo": "p1", "event": ["type": "", "ok": true],
                    "file": ["id": "f", "name": "a.png", "size": 3, "type": "image/png", "sha256": "nothex"],
                ], as: ClusterPostBody.self))
        XCTAssertEqual(
            body, ClusterPostBody(kind: .ask, text: "Which input action jumps?", to: [ClusterTarget(account: "bob")], replyTo: "p1"))
        XCTAssertNil(try read(["kind": "message", "text": "x", "to": [3]], as: ClusterPostBody.self)?.to, "an empty list is everyone")
        let event = ClusterEvent(
            json: try JSONDecoder().decode(
                ClusterJSON.self, from: Data(#"{"type":"submit","ok":"yes","count":2.5,"paths":["a",1,"b"]}"#.utf8)))
        XCTAssertEqual(event, ClusterEvent(type: "submit", paths: ["a", "b"]))
        let profile = try XCTUnwrap(try read(["tool": "vim", "status": "rigging", "statusAt": "never"], as: ClusterSessionProfile.self))
        XCTAssertEqual(profile, ClusterSessionProfile(status: "rigging"))
        // What its agent says of its delivery: kept when it reads, dropped otherwise; an older agent says neither.
        XCTAssertEqual(
            try read(["name": "rig", "delivery": "digest", "skipsPrompts": true], as: ClusterSessionProfile.self),
            ClusterSessionProfile(name: "rig", delivery: .digest, skipsPrompts: true))
        XCTAssertEqual(
            try read(["name": "rig", "delivery": "loud", "skipsPrompts": "yes"], as: ClusterSessionProfile.self),
            ClusterSessionProfile(name: "rig"))
        XCTAssertNil(try read(["name": "rig", "delivery": "muted", "skipsPrompts": false], as: ClusterSessionProfile.self)?.skipsPrompts)
        XCTAssertNil(ClusterSessionProfile(skipsPrompts: false).skipsPrompts, "only true is said")
        XCTAssertNil(try read(["name": "rig"], as: ClusterSessionProfile.self)?.delivery)
        let claims = try XCTUnwrap(
            try read(
                [
                    "claims": [
                        ["id": "c1", "paths": ["Content/Hero/**"], "account": "bob", "session": "s1", "at": "2026-11-04T10:00:00.000Z"],
                        ["id": "c2", "paths": [], "account": "bob", "session": "s1", "at": "2026-11-04T10:00:00Z"],
                        ["id": "c3", "paths": ["x"], "account": "bob", "session": "s1", "at": "soon"],
                    ]
                ], as: ClusterClaims.self))
        XCTAssertEqual(claims.claims.map(\.id), ["c1"])
        let clock = try XCTUnwrap(
            try read(
                [
                    "deadline": "2026-11-08T18:00:00Z",
                    "milestones": [["name": "Art lock", "at": "2026-11-07T12:00:00Z"], ["name": "", "at": "x"]],
                ],
                as: ClusterClock.self))
        XCTAssertEqual(
            clock,
            ClusterClock(deadline: "2026-11-08T18:00:00Z", milestones: [ClusterMilestone(name: "Art lock", at: "2026-11-07T12:00:00Z")]))
        // Sealed and opened again, what was kept comes back the same.
        XCTAssertEqual(vault.read(try vault.seal(body), as: ClusterPostBody.self), body)
        XCTAssertNil(vault.read("not a blob", as: ClusterPostBody.self))
    }

    func testAPostAndClaimsTheWebSealedOpenHere() throws {
        // Sealed by shared/cluster.ts with this key: the post with version 1, the claims with version 2.
        let post =
            "Q4ELgC2Q0Xy9GGjhTd0N2KYhL6J6WuZ5mO6VW/ngKz7rOIaW0yTA743sTF90qzUGUIvveofADbO9vVhhqjlVivaa77jw6NlQB2WcDOimY4HYcT37R3dFzdRqq+SYSm5L6pSrKuLBhjB5a2a0lk2cN0Ax4s0jZZ0xUzeAUNwebd7mqUXGnEfuqspQjyUFMnOqFUQg33x5VbK7nmhvGD+WXOOrdXT8bhPf/cIzaK4oqGdGvE5+zdNQUaQPxWgLgcS9GQDIS1O+Lh54iGVlO/mYlNT+QgMg8n19unvJ9yBIJ0r0lg=="
        let claims =
            "2:yzRbggFV08dQjs7wDk4hoqwcvFim1bxGh4Pkc5hpxyaFIRU21oCgV4nqBoEwHX0S0FblqYtAju5TPedV5kQIlmZn+MMmhvlMOGphDqsQ1X2zUP26yLpURRAMTGQK26RI6pGA1/oYR5hq6FUQUG2mvxHk2/VbSJrTdvKdSUvqppLsZeYHmr1kaHrC4xn4ccjGu5YPWay4m4NcQNGFInJhidUhr4cvFwyLyIA3WRqJzUYCS3uaEIucTG+K"
        var keyring = PoolKeyring(key: clusterKey)
        keyring.add(version: 2, key: clusterKey)
        let vault = ClusterVault(keyring: keyring)
        XCTAssertEqual(
            vault.post(post),
            ClusterPostBody(
                kind: .event, text: "submitted ✅", to: [ClusterTarget(account: "bob", session: "s1")], topic: "art",
                event: ClusterEvent(type: "submit", ok: true, ref: "1234", paths: ["Content/Maps/Main.umap"], count: 3)))
        XCTAssertEqual(
            vault.read(claims, as: ClusterClaims.self)?.claims,
            [
                ClusterClaim(
                    id: "c1", paths: ["Content/Hero/**"], reason: "rigging", account: "bob", session: "s1", at: "2026-11-04T10:00:00.000Z")
            ])
        // Version 1 alone does not open what version 2 sealed.
        XCTAssertNil(try ClusterVault(key: clusterKey).read(claims, as: ClusterClaims.self))
    }

    func testAPostIsForEveryoneAMemberOrOneSession() {
        let everyone = ClusterPostBody(kind: .message, text: "hi")
        XCTAssertTrue(Cluster.post(everyone, isFor: "alice", session: "s1"))
        let bob = ClusterPostBody(kind: .message, text: "hi", to: [ClusterTarget(account: "bob")])
        XCTAssertTrue(Cluster.post(bob, isFor: "bob", session: "any"))
        XCTAssertFalse(Cluster.post(bob, isFor: "alice", session: "any"))
        let one = ClusterPostBody(kind: .ask, text: "hi", to: [ClusterTarget(account: "bob", session: "s2")])
        XCTAssertTrue(Cluster.post(one, isFor: "bob", session: "s2"))
        XCTAssertFalse(Cluster.post(one, isFor: "bob", session: "s1"))
    }

    // MARK: The state

    private func update(_ object: [String: Any]) throws -> ClusterUpdate {
        try JSONDecoder().decode(ClusterUpdate.self, from: try JSONSerialization.data(withJSONObject: object))
    }

    private func snapshot(_ vault: ClusterVault) throws -> [String: Any] {
        [
            "id": "clus00000001", "createdAt": "2026-11-04T10:00:00.000Z", "keyVersion": 1,
            "info": try vault.seal(ClusterInfo(name: "Jam")),
            "members": [
                [
                    "account": "alice", "role": "owner", "joinedAt": "t", "profile": try vault.seal(ClusterMemberProfile(name: "Alice")),
                    "publicKeys": [],
                ],
                ["account": "bob", "role": "member", "joinedAt": "t", "profile": NSNull(), "publicKeys": []],
                ["account": "eve", "role": "admin", "joinedAt": "t", "profile": NSNull(), "publicKeys": []],
            ],
            "sessions": [
                [
                    "account": "bob", "session": "s1", "machine": "m1", "joinedAt": "t", "online": true, "ready": true, "status": "working",
                    "profile": try vault.seal(ClusterSessionProfile(name: "rig", tool: "claude")),
                ],
                [
                    "account": "bob", "session": "s2", "joinedAt": "t", "profile": NSNull(), "online": false, "ready": false,
                    "status": "dancing",
                ],
                ["account": "bob", "joinedAt": "t"],
            ],
            "posts": [
                [
                    "id": "p1", "seq": 1, "ts": "t", "account": "bob", "session": "s1",
                    "blob": try vault.seal(ClusterPostBody(kind: .message, text: "hello")),
                ],
                ["id": "p0", "seq": 0, "ts": "t", "account": "bob", "blob": "x"],
            ],
            "docs": [
                [
                    "name": "notes", "rev": 1, "updatedAt": "t", "account": "alice", "session": NSNull(),
                    "blob": try vault.seal(ClusterNotes(text: "Use UE 5.4")),
                ],
                ["name": "Bad Name", "rev": 1, "updatedAt": "t", "account": "alice", "session": NSNull(), "blob": "x"],
            ],
            "own": [
                "secret": NSNull(),
                "wraps": [["version": 1, "from": "alice", "blob": "x"], ["version": 2, "from": "alice", "blob": "w2"]],
            ],
        ]
    }

    func testTheSnapshotOpensAndLeavesOutWhatHasTheWrongShape() throws {
        let vault = try ClusterVault(key: clusterKey)
        guard case .snapshot(let wire) = try update(["t": "cluster_snapshot", "cluster": try snapshot(vault)]) else {
            return XCTFail("a snapshot")
        }
        let state = vault.snapshot(wire)
        XCTAssertEqual(state.info, ClusterInfo(name: "Jam"))
        // An unknown role, a session without an id, a post without a session field, a bad document name: left out.
        XCTAssertEqual(state.members.map(\.account), ["alice", "bob"])
        XCTAssertEqual(state.members.first?.profile, ClusterMemberProfile(name: "Alice"))
        XCTAssertEqual(state.sessions.map(\.session), ["s1", "s2"])
        XCTAssertEqual(state.sessions.first?.profile, ClusterSessionProfile(name: "rig", tool: "claude"))
        XCTAssertEqual(state.sessions.map(\.status), ["working", nil])
        XCTAssertEqual(state.posts.map(\.id), ["p1"])
        XCTAssertEqual(state.posts.first?.body?.text, "hello")
        XCTAssertEqual(state.docs.map(\.name), ["notes"])
        XCTAssertEqual(vault.notes(state), ClusterNotes(text: "Use UE 5.4"))
        // A wrap of version 1 is not a wrap.
        XCTAssertEqual(state.own.wraps.map(\.version), [2])
    }

    func testChangesFoldIntoTheState() throws {
        let vault = try ClusterVault(key: clusterKey)
        guard case .snapshot(let wire) = try update(["t": "cluster_snapshot", "cluster": try snapshot(vault)]) else {
            return XCTFail("a snapshot")
        }
        var state = vault.snapshot(wire)
        let id = "clus00000001"
        let post: [String: Any] = [
            "id": "p2", "seq": 2, "ts": "t", "account": "alice", "session": "s9", "machine": "m2",
            "blob": try vault.seal(ClusterPostBody(kind: .event, text: "pushed", event: ClusterEvent(type: "push", ok: true))),
        ]
        for _ in 0..<2 { state = try XCTUnwrap(vault.apply(try update(["t": "cluster_post", "clusterId": id, "post": post]), to: state)) }
        XCTAssertEqual(state.posts.map(\.id), ["p1", "p2"], "the same post twice is kept once")
        XCTAssertEqual(state.posts.last?.machine, "m2")

        let doc: [String: Any] = [
            "name": "notes", "rev": 2, "updatedAt": "t2", "account": "bob", "session": "s1",
            "blob": try vault.seal(ClusterNotes(text: "Use UE 5.5")),
        ]
        state = try XCTUnwrap(vault.apply(try update(["t": "cluster_doc", "clusterId": id, "doc": doc]), to: state))
        XCTAssertEqual(state.docs.map(\.rev), [2])
        XCTAssertEqual(vault.notes(state), ClusterNotes(text: "Use UE 5.5"))

        state = try XCTUnwrap(vault.apply(try update(["t": "cluster_member_left", "clusterId": id, "account": "bob"]), to: state))
        XCTAssertEqual(state.members.map(\.account), ["alice"])
        XCTAssertEqual(state.sessions, [], "its sessions go with it")

        state = try XCTUnwrap(
            vault.apply(
                try update(["t": "cluster_key", "clusterId": id, "wrap": ["version": 3, "from": "alice", "blob": "w3"]]), to: state))
        XCTAssertEqual(state.own.wraps.map(\.version), [2, 3])
        // Another cluster's change changes nothing; an error neither.
        let elsewhere = try update(["t": "cluster_member_left", "clusterId": "clus00000002", "account": "alice"])
        XCTAssertEqual(vault.apply(elsewhere, to: state), state)
        XCTAssertEqual(vault.apply(try update(["t": "cluster_error", "clusterId": id, "message": "no"]), to: state), state)
        XCTAssertNil(vault.apply(try update(["t": "cluster_removed", "clusterId": id]), to: state))
    }

    func testMessagesOfTheWrongShapeAreDropped() {
        XCTAssertThrowsError(try update(["t": "cluster_unknown", "clusterId": "c"]))
        XCTAssertThrowsError(try update(["t": "cluster_post", "clusterId": "c", "post": ["id": 1]]))
        XCTAssertThrowsError(try update(["t": "cluster_key", "clusterId": "c", "wrap": ["version": 1, "from": "a", "blob": "b"]]))
        XCTAssertThrowsError(try update(["t": "cluster_conflict", "clusterId": "c", "name": "notes"]), "a conflict says what is current")
        XCTAssertNoThrow(try update(["t": "cluster_conflict", "clusterId": "c", "name": "notes", "current": NSNull()]))
    }

    func testTheKeyringOpensANewVersionFromTheOwnersWrap() throws {
        let accountKey = try E2E.key(fromBase64URL: E2E.newKey())
        let vault = SessionVault(key: accountKey)
        let clusterId = "clus00000001"
        let v2 = E2E.newKey()
        let keyring = PoolKeyring(key: clusterKey)
        let owner = try vault.newClusterMemberKeys(clusterId: clusterId, account: "owner0000001", keyring: keyring)
        let member = try vault.newClusterMemberKeys(clusterId: clusterId, account: "member000001", keyring: keyring)
        let scope = Cluster.keyScope(clusterId)
        let ownerSecret = try XCTUnwrap(vault.poolMemberSecret(owner.secret, poolId: scope))
        let memberSecret = try XCTUnwrap(vault.poolMemberSecret(member.secret, poolId: scope))
        // A cluster's secret is not a pool's of the same id.
        XCTAssertNil(vault.poolMemberSecret(owner.secret, poolId: clusterId))
        let wrap = try PoolKeys.wrap(
            PoolKeyWrap(poolId: scope, version: 2, key: v2, from: "owner0000001", to: "member000001"), admin: ownerSecret,
            memberPublic: memberSecret.publicKey)
        let members = [
            ClusterMemberWire(account: "owner0000001", role: .owner, joinedAt: "t", profile: nil, publicKeys: [owner.publicKey]),
            ClusterMemberWire(account: "member000001", role: .member, joinedAt: "t", profile: nil, publicKeys: [member.publicKey]),
        ]
        let resolved = try XCTUnwrap(
            vault.clusterKeyring(
                grant: try vault.sealClusterKeyGrant(clusterId: clusterId, key: clusterKey, version: 1),
                own: PoolOwnKeys(secret: member.secret, wraps: [PoolKeyWrapWire(version: 2, from: "owner0000001", blob: wrap)]),
                members: members, clusterId: clusterId, account: "member000001"))
        XCTAssertEqual(resolved.versions, [1, 2])
        XCTAssertEqual(resolved.key(2), v2)
    }
}
