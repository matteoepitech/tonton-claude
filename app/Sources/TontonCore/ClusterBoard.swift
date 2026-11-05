import Foundation

// One cluster of the account as a client follows it, like PoolBoard for pools and ClusterWatch in shared/cluster-watch.ts:
// how the relay lists it, the versions of its key this member holds, its state once the snapshot came, and the last thing
// the relay refused. Apps never post (docs/cluster.md): what they change is who is in, their own sessions, their name and
// the clock.

public struct ClusterBoard: Equatable, Sendable {
    public private(set) var summary: ClusterSummary
    public private(set) var keyring: PoolKeyring
    public private(set) var state: ClusterState?
    /// The last thing the relay refused, to show once.
    public var problem: String?

    /// Nil when the member's copy of the cluster key does not open with the account key.
    public init?(summary: ClusterSummary, vault: SessionVault) {
        guard let joined = vault.clusterKey(from: summary.key, clusterId: summary.id) else { return nil }
        self.summary = summary
        keyring = PoolKeyring(key: joined.key, version: joined.version)
    }

    public var id: String { summary.id }
    public var role: ClusterRole { summary.role }
    public var isOwner: Bool { summary.role == .owner }
    public var vault: ClusterVault { ClusterVault(keyring: keyring) }
    /// Its name and what it is for, as soon as the listing opens.
    public var info: ClusterInfo? { state?.info ?? vault.info(summary.info) }
    public var name: String { info?.name ?? String(core: "A cluster") }
    public var notes: ClusterNotes? { state.flatMap(vault.notes) }
    public var claims: ClusterClaims? { state.flatMap(vault.claims) }
    public var clock: ClusterClock? { state.flatMap(vault.clock) }
    /// The revision a new clock replaces: 0 while there is none.
    public var clockRev: Int { state?.docs.first { $0.name == "clock" }?.rev ?? 0 }
    public var memberCount: Int { state?.members.count ?? summary.members }

    /// A newer listing of the same cluster: its key version or its member count changed.
    public mutating func list(_ summary: ClusterSummary) {
        guard summary.id == id else { return }
        self.summary = summary
    }

    /// Folds a change in, opening newer versions of the key as they come. False when the cluster is gone for this member.
    public mutating func take(_ update: ClusterUpdate, account: String, vault accountVault: SessionVault) -> Bool {
        guard update.clusterId == id else { return true }
        switch update {
        case .snapshot(let snapshot):
            if let resolved = accountVault.clusterKeyring(
                grant: summary.key, own: snapshot.own, members: snapshot.members, clusterId: id, account: account),
                resolved.version >= keyring.version
            {
                keyring = resolved
            }
            state = vault.snapshot(snapshot)
        case .removed:
            return false
        case .error(_, let message):
            problem = message
        case .conflict(_, let name, let current):
            if let current, let state { self.state = vault.apply(.doc(clusterId: id, current), to: state) }
            // The leaderboard is written again over the newer board (ClusterStore), without asking anyone.
            guard name != ClusterHeroes.document else { return true }
            problem =
                name == "clock"
                ? String(core: "Someone changed the clock meanwhile: check it and try again.")
                : String(core: "Someone changed this document meanwhile: check it and try again.")
        default:
            guard let current = state else { return true }
            guard let next = vault.apply(update, to: current) else { return false }
            state = next
            switch update {
            case .key, .member: follow(account: account, vault: accountVault)
            default: break
            }
        }
        return true
    }

    /// Opens the versions wrapped for this member with the public keys the members published.
    private mutating func follow(account: String, vault accountVault: SessionVault) {
        guard let state else { return }
        let members = state.members.map {
            ClusterMemberWire(account: $0.account, role: $0.role, joinedAt: $0.joinedAt, profile: nil, publicKeys: $0.publicKeys)
        }
        if let resolved = accountVault.clusterKeyring(
            grant: summary.key, own: state.own, members: members, clusterId: id, account: account),
            resolved.version >= keyring.version
        {
            keyring = resolved
        }
    }

    /// After a rotation: this member's public key sealed with the latest version, and its private key, for the owner to
    /// wrap the next version for it. Nil while it is already there, as `needsRepublish` in shared/pool-keys.ts says.
    public func republished(account: String, vault accountVault: SessionVault) -> (publicKey: String, secret: String)? {
        guard let state, keyring.version > 0, let me = state.members.first(where: { $0.account == account }),
            !me.publicKeys.contains(where: { PoolKeyring.version(of: $0) == keyring.version }),
            let sealed = try? accountVault.resealClusterMemberKeys(state.own.secret, clusterId: id, account: account, keyring: keyring)
        else { return nil }
        return sealed
    }

    /// One session of the cluster, by its account and id.
    public func session(_ sessionId: String, of account: String) -> ClusterState.Session? {
        state?.sessions.first { $0.account == account && $0.session == sessionId }
    }

    public static func == (a: ClusterBoard, b: ClusterBoard) -> Bool {
        a.summary == b.summary && a.keyring.versions == b.keyring.versions && a.state == b.state && a.problem == b.problem
    }
}

extension SessionVault {
    /// The member's key pair for a cluster, its public key sealed again with the keyring's latest version.
    func resealClusterMemberKeys(
        _ sealedSecret: String?, clusterId: String, account: String, keyring: PoolKeyring
    ) throws -> (publicKey: String, secret: String)? {
        let scope = Cluster.keyScope(clusterId)
        guard let secret = poolMemberSecret(sealedSecret, poolId: scope) else { return nil }
        return (try keyring.seal(PoolMemberKey(poolId: scope, account: account, key: secret.publicKey)), try E2E.seal(secret, with: key))
    }
}
