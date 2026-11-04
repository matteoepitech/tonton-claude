import CryptoKit
import Foundation
import XCTest

@testable import TontonCore

/// The notch's side of a cluster against the relay: what the routes get (ClusterAPI.swift), an older relay's 404, the
/// relay's messages reaching the cluster, and a cluster as the notch follows it (ClusterBoard.swift).
final class ClusterAPITests: XCTestCase {
    private let account = Account(relay: "https://relay.example.com", accountId: "acct00000001", token: "ta_x", key: E2E.newKey())
    private var vault: SessionVault { SessionVault(key: (try? account.symmetricKey()) ?? .init(size: .bits256)) }

    override func tearDown() {
        StubRelay.answer = nil
        StubRelay.requests = []
        super.tearDown()
    }

    private var api: RelayAPI {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubRelay.self]
        return RelayAPI(session: URLSession(configuration: configuration))
    }

    private func body(_ request: URLRequest) throws -> [String: Any] {
        let data = try XCTUnwrap(StubRelay.body(of: request))
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func summary(id: String, key: String, role: String = "owner") throws -> [String: Any] {
        [
            "id": id, "role": role, "createdAt": "2026-11-04T10:00:00.000Z", "keyVersion": 1,
            "info": try ClusterVault(key: key).seal(ClusterInfo(name: "Jam")),
            "key": try vault.sealClusterKeyGrant(clusterId: id, key: key, version: 1), "members": 1, "secret": NSNull(), "wraps": [],
        ]
    }

    func testCreatingMakesTheKeyHereAndSendsItOnlySealed() async throws {
        var sent: [String: Any] = [:]
        StubRelay.answer = { request in
            sent = (try? self.body(request)) ?? [:]
            let id = sent["id"] as? String ?? ""
            let summary = try JSONSerialization.data(withJSONObject: [
                "cluster": [
                    "id": id, "role": "owner", "createdAt": "t", "keyVersion": 1, "info": sent["info"] ?? "", "key": sent["key"] ?? "",
                    "members": 1, "secret": sent["secret"] ?? NSNull(), "wraps": [],
                ]
            ])
            return (200, summary)
        }
        let created = try await api.createCluster(
            ClusterInfo(name: "Jam", about: "48 hours"), profile: ClusterMemberProfile(name: "Val"), for: account, vault: vault)
        let request = try XCTUnwrap(StubRelay.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "https://relay.example.com/api/clusters")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer ta_x")
        let id = try XCTUnwrap(sent["id"] as? String)
        XCTAssertNotNil(id.wholeMatch(of: #/[A-Za-z0-9_-]{12}/#))
        XCTAssertEqual(created.id, id)
        // The key is in the member's copy, sealed with the account key; what the cluster says is sealed with it.
        let key = try XCTUnwrap(vault.clusterKey(from: try XCTUnwrap(sent["key"] as? String), clusterId: id))
        XCTAssertEqual(key.version, 1)
        let cluster = try ClusterVault(key: key.key)
        XCTAssertEqual(cluster.info(sent["info"] as? String), ClusterInfo(name: "Jam", about: "48 hours"))
        XCTAssertEqual(cluster.read(sent["profile"] as? String, as: ClusterMemberProfile.self), ClusterMemberProfile(name: "Val"))
        XCTAssertNotNil(vault.poolMemberSecret(sent["secret"] as? String, poolId: Cluster.keyScope(id)))
        let publicKey = PoolKeys.publicKey(
            in: [try XCTUnwrap(sent["publicKey"] as? String)], keyring: cluster.keyring, poolId: Cluster.keyScope(id),
            account: "acct00000001")
        XCTAssertNotNil(publicKey, "its public key, bound to this account, sealed with the cluster key")
        XCTAssertNotNil(ClusterBoard(summary: created, vault: vault))
    }

    func testJoiningSendsTheInviteTokenAndKeepsTheKeySealed() async throws {
        let key = E2E.newKey()
        let invite = ClusterInvite(
            relay: account.relay, cluster: "clus00000001", token: "tc_abcdefghijkl_" + String(repeating: "t", count: 43), key: key,
            version: 2)
        var sent: [String: Any] = [:]
        StubRelay.answer = { request in
            sent = (try? self.body(request)) ?? [:]
            return (200, try JSONSerialization.data(withJSONObject: ["cluster": try self.summary(id: "clus00000001", key: key)]))
        }
        _ = try await api.joinCluster(invite, profile: nil, for: account, vault: vault)
        XCTAssertEqual(StubRelay.requests.first?.url?.path, "/api/clusters/join")
        XCTAssertEqual(sent["invite"] as? String, invite.token)
        XCTAssertNil(sent["profile"], "no name: none sent")
        XCTAssertEqual(vault.clusterKey(from: try XCTUnwrap(sent["key"] as? String), clusterId: "clus00000001")?.version, 2)
        XCTAssertNil(sent["id"])
    }

    func testAnInviteIsReadForThisRelayOnly() throws {
        let invite = ClusterInvite(
            relay: "https://other.example.com", cluster: "clus00000001", token: "tc_abcdefghijkl_" + String(repeating: "t", count: 43),
            key: E2E.newKey(), version: 1)
        XCTAssertThrowsError(try Cluster.invite(in: invite.link, relay: account.relay)) { error in
            XCTAssertEqual((error as? RelayError)?.message, "This invite is for another relay: other.example.com.")
        }
        XCTAssertThrowsError(try Cluster.invite(in: "tontonpool1.abc", relay: account.relay)) { error in
            XCTAssertEqual((error as? RelayError)?.message, "This is not a cluster invite: it starts with tontoncluster1.")
        }
        let ours = ClusterInvite(relay: account.relay, cluster: invite.cluster, token: invite.token, key: invite.key, version: 1)
        XCTAssertEqual(try Cluster.invite(in: "  \(ours.link)\n", relay: account.relay + "/"), ours)
    }

    func testAnOlderRelayIsToldApartFromAClusterThatIsGone() async throws {
        StubRelay.answer = { _ in (404, Data(#"{"error":"not found"}"#.utf8)) }
        do {
            _ = try await api.clusters(of: account)
            XCTFail("a 404")
        } catch {
            XCTAssertTrue(Cluster.isUnsupported(error))
        }
        StubRelay.answer = { _ in (404, Data("<html>".utf8)) }
        do {
            try await api.leaveCluster("clus00000001", of: account)
            XCTFail("a 404")
        } catch {
            XCTAssertTrue(Cluster.isUnsupported(error), "a 404 without a body: HTTP 404")
        }
        XCTAssertFalse(Cluster.isUnsupported(RelayError(message: "No such cluster.", status: 404)))
        XCTAssertFalse(Cluster.isUnsupported(RelayError(message: "not found", status: 500)))
        XCTAssertEqual(Cluster.unsupported, "This relay doesn't know clusters yet: it needs updating.")
    }

    func testInvitesAreMadeListedAndRevoked() async throws {
        StubRelay.answer = { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/api/clusters/clus00000001/invites"):
                return (
                    200,
                    Data(#"{"id":"inv000000001","token":"tc_x","usesLeft":20,"createdAt":"t","expiresAt":"2026-11-11T10:00:00.000Z"}"#.utf8)
                )
            case ("GET", "/api/clusters/clus00000001/invites"):
                return (200, Data(#"[{"id":"inv000000001","usesLeft":19,"createdAt":"t","expiresAt":"e"}]"#.utf8))
            case ("DELETE", "/api/clusters/clus00000001/invites/inv000000001"), ("DELETE", "/api/clusters/clus00000001"):
                return (200, Data(#"{"ok":true}"#.utf8))
            default:
                return (404, Data(#"{"error":"not found"}"#.utf8))
            }
        }
        let made = try await api.createClusterInvite("clus00000001", uses: 20, hours: 168, for: account)
        XCTAssertEqual(made.token, "tc_x")
        XCTAssertEqual(try body(try XCTUnwrap(StubRelay.requests.first)) as? [String: Int], ["uses": 20, "hours": 168])
        let open = try await api.clusterInvites("clus00000001", of: account)
        XCTAssertEqual(open.map(\.usesLeft), [19])
        try await api.revokeClusterInvite("inv000000001", cluster: "clus00000001", of: account)
        try await api.deleteCluster("clus00000001", of: account)
        XCTAssertEqual(StubRelay.requests.map(\.httpMethod), ["POST", "GET", "DELETE", "DELETE"])
    }

    func testTheRelaysClusterMessagesReachTheApp() throws {
        func decode(_ json: String) throws -> RelayMessage { try JSONDecoder().decode(RelayMessage.self, from: Data(json.utf8)) }
        guard
            case .cluster(.memberLeft("clus00000001", "bob")) = try decode(
                #"{"t":"cluster_member_left","clusterId":"clus00000001","account":"bob"}"#)
        else { return XCTFail("a member left") }
        guard case .cluster(.removed("clus00000001")) = try decode(#"{"t":"cluster_removed","clusterId":"clus00000001"}"#) else {
            return XCTFail("removed")
        }
        // One this app does not know, or of the wrong shape, is skipped.
        guard case .unknown = try decode(#"{"t":"cluster_dance","clusterId":"c"}"#) else { return XCTFail("unknown") }
        guard case .unknown = try decode(#"{"t":"cluster_post","clusterId":"c","post":{"id":1}}"#) else { return XCTFail("unknown") }
    }

    // MARK: A cluster as the notch follows it

    private func snapshot(_ cluster: ClusterVault, members: [[String: Any]], own: [String: Any]? = nil) throws -> ClusterUpdate {
        var body: [String: Any] = [
            "id": "clus00000001", "createdAt": "t", "keyVersion": cluster.keyring.version,
            "info": try cluster.seal(ClusterInfo(name: "Jam")), "members": members, "sessions": [], "posts": [],
            "docs": [
                [
                    "name": "clock", "rev": 4, "updatedAt": "t", "account": "acct00000001", "session": NSNull(),
                    "blob": try cluster.seal(ClusterClock(deadline: "2026-11-08T18:00:00Z")),
                ]
            ],
        ]
        if let own { body["own"] = own }
        let data = try JSONSerialization.data(withJSONObject: ["t": "cluster_snapshot", "cluster": body])
        return try JSONDecoder().decode(ClusterUpdate.self, from: data)
    }

    private func message(_ object: [String: Any]) throws -> ClusterUpdate {
        try JSONDecoder().decode(ClusterUpdate.self, from: try JSONSerialization.data(withJSONObject: object))
    }

    func testABoardOpensItsSnapshotAndSaysWhatTheRelayRefused() throws {
        let key = E2E.newKey()
        let summary = try JSONDecoder().decode(
            ClusterSummary.self, from: try JSONSerialization.data(withJSONObject: try self.summary(id: "clus00000001", key: key)))
        var board = try XCTUnwrap(ClusterBoard(summary: summary, vault: vault))
        XCTAssertEqual(board.name, "Jam", "the name opens from the listing")
        XCTAssertNil(ClusterBoard(summary: summary, vault: SessionVault(key: .init(size: .bits256))), "another account's copy")
        let cluster = try ClusterVault(key: key)
        let owner: [String: Any] = ["account": "acct00000001", "role": "owner", "joinedAt": "t", "profile": NSNull(), "publicKeys": []]
        XCTAssertTrue(board.take(try snapshot(cluster, members: [owner]), account: "acct00000001", vault: vault))
        XCTAssertEqual(board.clock?.deadline, "2026-11-08T18:00:00Z")
        XCTAssertEqual(board.clockRev, 4)
        XCTAssertEqual(board.memberCount, 1)

        let conflict: [String: Any] = [
            "t": "cluster_conflict", "clusterId": "clus00000001", "name": "clock",
            "current": [
                "name": "clock", "rev": 5, "updatedAt": "t2", "account": "acct00000002", "session": NSNull(),
                "blob": try cluster.seal(ClusterClock(deadline: "2026-11-09T18:00:00Z")),
            ],
        ]
        XCTAssertTrue(board.take(try message(conflict), account: "acct00000001", vault: vault))
        XCTAssertEqual(board.clockRev, 5, "the current clock, to write over next")
        XCTAssertEqual(board.clock?.deadline, "2026-11-09T18:00:00Z")
        XCTAssertEqual(board.problem, "Someone changed the clock meanwhile: check it and try again.")
        let error: [String: Any] = ["t": "cluster_error", "clusterId": "clus00000001", "message": "Slow down."]
        XCTAssertTrue(board.take(try message(error), account: "acct00000001", vault: vault))
        XCTAssertEqual(board.problem, "Slow down.")
        let elsewhere: [String: Any] = ["t": "cluster_removed", "clusterId": "clus00000002"]
        XCTAssertTrue(board.take(try message(elsewhere), account: "acct00000001", vault: vault), "another cluster's")
        XCTAssertFalse(
            board.take(try message(["t": "cluster_removed", "clusterId": "clus00000001"]), account: "acct00000001", vault: vault))
    }

    func testAfterARotationTheMemberPublishesItsKeyUnderTheNewVersion() throws {
        let clusterId = "clus00000001"
        let v1 = E2E.newKey()
        let v2 = E2E.newKey()
        let scope = Cluster.keyScope(clusterId)
        let ownerVault = SessionVault(key: .init(size: .bits256))
        let owner = try ownerVault.newClusterMemberKeys(clusterId: clusterId, account: "owner0000001", keyring: PoolKeyring(key: v1))
        let me = try vault.newClusterMemberKeys(clusterId: clusterId, account: "acct00000001", keyring: PoolKeyring(key: v1))
        let wrap = try PoolKeys.wrap(
            PoolKeyWrap(poolId: scope, version: 2, key: v2, from: "owner0000001", to: "acct00000001"),
            admin: try XCTUnwrap(ownerVault.poolMemberSecret(owner.secret, poolId: scope)),
            memberPublic: try XCTUnwrap(vault.poolMemberSecret(me.secret, poolId: scope)).publicKey)
        let summary = try JSONDecoder().decode(
            ClusterSummary.self,
            from: try JSONSerialization.data(withJSONObject: try self.summary(id: clusterId, key: v1, role: "member")))
        var board = try XCTUnwrap(ClusterBoard(summary: summary, vault: vault))
        var keyring = PoolKeyring(key: v1)
        keyring.add(version: 2, key: v2)
        let members: [[String: Any]] = [
            ["account": "owner0000001", "role": "owner", "joinedAt": "t", "profile": NSNull(), "publicKeys": [owner.publicKey]],
            ["account": "acct00000001", "role": "member", "joinedAt": "t", "profile": NSNull(), "publicKeys": [me.publicKey]],
        ]
        let own: [String: Any] = ["secret": me.secret, "wraps": [["version": 2, "from": "owner0000001", "blob": wrap]]]
        XCTAssertTrue(
            board.take(try snapshot(ClusterVault(keyring: keyring), members: members, own: own), account: "acct00000001", vault: vault))
        XCTAssertEqual(board.keyring.versions, [1, 2])
        XCTAssertEqual(board.name, "Jam", "read with version 2")
        let republished = try XCTUnwrap(board.republished(account: "acct00000001", vault: vault))
        XCTAssertEqual(PoolKeyring.version(of: republished.publicKey), 2)
        XCTAssertNotNil(PoolKeys.publicKey(in: [republished.publicKey], keyring: board.keyring, poolId: scope, account: "acct00000001"))
        XCTAssertNotNil(vault.poolMemberSecret(republished.secret, poolId: scope))
        // Once published under version 2, nothing more to send.
        let published: [String: Any] = [
            "t": "cluster_member", "clusterId": clusterId,
            "member": [
                "account": "acct00000001", "role": "member", "joinedAt": "t", "profile": NSNull(), "publicKeys": [republished.publicKey],
            ],
        ]
        XCTAssertTrue(board.take(try message(published), account: "acct00000001", vault: vault))
        XCTAssertNil(board.republished(account: "acct00000001", vault: vault))
    }
}

/// Answers the requests of a test's URLSession, keeping each one.
final class StubRelay: URLProtocol {
    nonisolated(unsafe) static var answer: ((URLRequest) throws -> (Int, Data))?
    nonisolated(unsafe) static var requests: [URLRequest] = []

    /// URLSession hands the protocol a stream rather than the body.
    static func body(of request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            guard read > 0 else { break }
            data.append(buffer, count: read)
        }
        return data
    }

    override static func canInit(with request: URLRequest) -> Bool { true }
    override static func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var kept = request
        kept.httpBody = Self.body(of: request)
        Self.requests.append(kept)
        do {
            let (status, data) = try Self.answer?(kept) ?? (500, Data())
            let response = HTTPURLResponse(
                url: request.url ?? URL(fileURLWithPath: "/"), statusCode: status, httpVersion: nil, headerFields: nil)
            client?.urlProtocol(self, didReceive: response ?? URLResponse(), cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
