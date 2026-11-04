import Foundation

// The cluster routes of the relay, for the account (docs/cluster.md, Messages), as shared/cluster-api.ts calls them: list,
// create with a new key, join with an invite, leave, delete, members and invites. The cluster key is made here and leaves
// only sealed with the account key, or in the invites the owner hands out. Kicking a member rotates the key with a wrap per
// member: shared/pool-keys.ts does it, this client does not yet, so the notch sends the owner to the website for it.

/// An open invite, as the relay lists it: never its token, which it only keeps hashed.
public struct ClusterInviteSummary: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let usesLeft: Int
    public let createdAt: String
    public let expiresAt: String
}

/// A new invite: its token goes into the link, and the relay never shows it again.
public struct ClusterInviteCreated: Codable, Equatable, Sendable {
    public let id: String
    public let token: String
    public let usesLeft: Int
    public let expiresAt: String
}

extension Cluster {
    /// 9 random bytes in base64url, 12 characters, as shared/cluster.ts makes them: the client picks the id so that the
    /// member's copy of the key names its cluster.
    public static func newId() -> String {
        Data((0..<9).map { _ in UInt8.random(in: 0...255) }).base64URLEncodedString()
    }

    /// What the notch says when the relay predates clusters.
    public static var unsupported: String { String(core: "This relay doesn't know clusters yet: it needs updating.") }

    /// A relay from before clusters answers every cluster route with its own 404; a cluster this account is not in is
    /// "No such cluster." instead.
    public static func isUnsupported(_ error: Error) -> Bool {
        guard let error = error as? RelayError, error.status == 404 else { return false }
        return error.message.localizedCaseInsensitiveContains("not found") || error.message == "HTTP 404"
    }

    /// The invite in a pasted text or link, for this relay only: an invite for another relay would join nothing here.
    public static func invite(in text: String, relay: String) throws -> ClusterInvite {
        guard let invite = ClusterInvite(string: text) else {
            throw RelayError(message: String(core: "This is not a cluster invite: it starts with tontoncluster1."))
        }
        let theirs = URL(string: invite.relay)
        let ours = URL(string: RelayAPI.normalize(relay))
        guard let theirs, let ours, theirs.host?.lowercased() == ours.host?.lowercased(), theirs.scheme == ours.scheme,
            theirs.port == ours.port
        else {
            throw RelayError(message: String(core: "This invite is for another relay: \(theirs?.host ?? invite.relay)."))
        }
        return invite
    }
}

extension RelayAPI {
    private struct Done: Decodable { let ok: Bool }
    private struct Wrapped: Decodable { let cluster: ClusterSummary }

    /// What a member publishes on creating or joining: the cluster key sealed with the account key, its name sealed with
    /// the cluster key, and its key pair.
    private struct MemberBody: Encodable {
        var id: String? = nil
        var info: String? = nil
        var invite: String? = nil
        let key: String
        let profile: String?
        let publicKey: String
        let secret: String
    }

    /// The account's clusters, with its role and its keys for each.
    public func clusters(of account: Account) async throws -> [ClusterSummary] {
        try await request("GET", account.relay, "/api/clusters", token: account.token, as: [ClusterSummary].self)
    }

    /// Makes the cluster, its key and this member's key pair for it. The key is in the member's copy of the summary.
    public func createCluster(
        _ info: ClusterInfo, profile: ClusterMemberProfile?, for account: Account, vault: SessionVault
    ) async throws -> ClusterSummary {
        let key = E2E.newKey()
        let cluster = try ClusterVault(key: key)
        let id = Cluster.newId()
        let member = try vault.newClusterMemberKeys(clusterId: id, account: account.accountId, keyring: cluster.keyring)
        let body = MemberBody(
            id: id, info: try cluster.seal(info), key: try vault.sealClusterKeyGrant(clusterId: id, key: key, version: 1),
            profile: try profile.map(cluster.seal), publicKey: member.publicKey, secret: member.secret)
        return try await request(
            "POST", account.relay, "/api/clusters", token: account.token, body: try JSONEncoder().encode(body), as: Wrapped.self
        ).cluster
    }

    /// Joins with an invite, keeping the cluster key sealed with the account key for the account's other devices and machines.
    public func joinCluster(
        _ invite: ClusterInvite, profile: ClusterMemberProfile?, for account: Account, vault: SessionVault
    ) async throws -> ClusterSummary {
        let cluster = ClusterVault(keyring: PoolKeyring(key: invite.key, version: invite.version))
        let member = try vault.newClusterMemberKeys(clusterId: invite.cluster, account: account.accountId, keyring: cluster.keyring)
        let body = MemberBody(
            invite: invite.token, key: try vault.sealClusterKeyGrant(clusterId: invite.cluster, key: invite.key, version: invite.version),
            profile: try profile.map(cluster.seal), publicKey: member.publicKey, secret: member.secret)
        return try await request(
            "POST", account.relay, "/api/clusters/join", token: account.token, body: try JSONEncoder().encode(body), as: Wrapped.self
        ).cluster
    }

    /// The owner deletes the cluster for everyone.
    public func deleteCluster(_ clusterId: String, of account: Account) async throws {
        _ = try await request("DELETE", account.relay, "/api/clusters/\(clusterId)", token: account.token, as: Done.self)
    }

    /// A member leaves; its sessions leave with it.
    public func leaveCluster(_ clusterId: String, of account: Account) async throws {
        _ = try await request(
            "POST", account.relay, "/api/clusters/\(clusterId)/leave", token: account.token, body: Data("{}".utf8), as: Done.self)
    }

    /// The members, with their roles and their public keys, sealed.
    public func clusterMembers(_ clusterId: String, of account: Account) async throws -> [ClusterMemberWire] {
        try await request("GET", account.relay, "/api/clusters/\(clusterId)/members", token: account.token, as: [ClusterMemberWire].self)
    }

    /// The owner: `uses` from 1 to 100, `hours` from 1 to 720.
    public func createClusterInvite(_ clusterId: String, uses: Int, hours: Int, for account: Account) async throws -> ClusterInviteCreated {
        let body = try JSONEncoder().encode(["uses": uses, "hours": hours])
        return try await request(
            "POST", account.relay, "/api/clusters/\(clusterId)/invites", token: account.token, body: body, as: ClusterInviteCreated.self)
    }

    public func clusterInvites(_ clusterId: String, of account: Account) async throws -> [ClusterInviteSummary] {
        try await request(
            "GET", account.relay, "/api/clusters/\(clusterId)/invites", token: account.token, as: [ClusterInviteSummary].self)
    }

    public func revokeClusterInvite(_ inviteId: String, cluster clusterId: String, of account: Account) async throws {
        _ = try await request(
            "DELETE", account.relay, "/api/clusters/\(clusterId)/invites/\(inviteId)", token: account.token, as: Done.self)
    }
}
