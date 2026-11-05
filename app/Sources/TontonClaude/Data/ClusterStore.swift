import AppKit
import Combine
import Foundation
import OSLog
import TontonCore

/// The account's clusters in the notch (docs/cluster.md), as PoolStore does for pools and shared/cluster-watch.ts for the
/// website: listed when the app connects, followed on the relay socket, opened with the keys this member holds. It
/// creates, joins, leaves and deletes clusters, invites, puts the account's own sessions in and takes them out, and lets
/// the owner set the clock. It never posts: the sessions do, and people read.
@MainActor
final class ClusterStore: ObservableObject {
    static let shared = ClusterStore()

    /// By cluster id.
    @Published private(set) var boards: [String: ClusterBoard] = [:]
    /// What the last list, create or join said when it failed.
    @Published private(set) var problem: String?
    /// False once the relay answered 404 to the cluster routes: it predates clusters.
    @Published private(set) var supported = true
    /// The delivery chosen last for each session in each cluster: the order itself is sealed for its agent alone.
    @Published private(set) var choices = ClusterChoices(data: UserDefaults.standard.data(forKey: ClusterStore.choicesKey))
    /// The cluster whose page the notch shows, kept while the panel is closed.
    @Published var opened: String?
    /// The name the others see, as typed last on creating or joining.
    @Published var memberName = UserDefaults.standard.string(forKey: ClusterStore.nameKey) ?? NSFullUserName() {
        didSet { UserDefaults.standard.set(memberName, forKey: Self.nameKey) }
    }

    private static let choicesKey = "clusterDeliveries"
    private static let nameKey = "clusterMemberName"
    private var account: Account?
    private var vault: SessionVault?
    private var send: (([String: Any]) -> Void)?
    /// The key versions this member already published its public key under, so a snapshot does not send it twice.
    private var republished: Set<String> = []
    private let api = RelayAPI()
    /// Whether this member asked to share its Tonton, per cluster, until the board says it: made again after a crossed write.
    private var sharing: [String: Bool] = [:]
    private var heroChanges: AnyCancellable?

    /// The clusters, by name.
    var ordered: [ClusterBoard] { boards.values.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending } }
    var accountId: String? { account?.accountId }

    // MARK: Connection

    /// The socket is up: lists the account's clusters and follows each one.
    func connected(account: Account, vault: SessionVault, send: @escaping ([String: Any]) -> Void) {
        self.account = account
        self.vault = vault
        self.send = send
        // A hero that changes moves its entry on every leaderboard it is on.
        heroChanges = RPGStore.shared.$hero.removeDuplicates().sink { [weak self] _ in
            Task { @MainActor in self?.keepHeroes() }
        }
        // The relay forgot what a dropped socket followed.
        for clusterId in boards.keys { send(["t": "cluster_subscribe", "clusterId": clusterId]) }
        Task { await refresh() }
    }

    /// Another account, signed out, or the socket went down: nothing of the previous one stays.
    func reset() {
        (account, vault, send) = (nil, nil, nil)
        boards = [:]
        problem = nil
        supported = true
        republished = []
        sharing = [:]
        heroChanges = nil
    }

    /// Lists the clusters again: one joined on the website shows up, one left there goes.
    func refresh() async {
        guard let account, let vault else { return }
        do {
            let summaries = try await api.clusters(of: account)
            guard self.account == account else { return }
            (problem, supported) = (nil, true)
            var next: [String: ClusterBoard] = [:]
            for summary in summaries {
                if var known = boards[summary.id] {
                    known.list(summary)
                    next[summary.id] = known
                } else if let board = ClusterBoard(summary: summary, vault: vault) {
                    next[summary.id] = board
                    send?(["t": "cluster_subscribe", "clusterId": summary.id])
                }
            }
            boards = next
        } catch {
            fail(error)
        }
    }

    func apply(_ update: ClusterUpdate) {
        guard let account, let vault else { return }
        let clusterId = update.clusterId
        guard var board = boards[clusterId] else { return }
        let startedAt = board.clock?.startedAt
        guard board.take(update, account: account.accountId, vault: vault) else {
            boards[clusterId] = nil
            forget(clusterId)
            return
        }
        boards[clusterId] = board
        switch update {
        case .key:
            // A new version of the key: the next snapshot is read with it.
            send?(["t": "cluster_subscribe", "clusterId": clusterId])
        case .snapshot:
            republish(board)
            keepHero(in: clusterId)
        case .conflict(_, let name, _) where name == ClusterHeroes.document:
            keepHero(in: clusterId)
        case .doc where board.clock?.startedAt != startedAt:
            // A clock that starts (again) is where every count starts.
            keepHero(in: clusterId)
        case .error(_, let message):
            Logger.app.error("cluster \(clusterId): \(message)")
        default:
            break
        }
    }

    func clearProblem(_ clusterId: String? = nil) {
        if let clusterId {
            boards[clusterId]?.problem = nil
        } else {
            problem = nil
        }
    }

    func websiteURL() -> URL? { account.flatMap { URL(string: RelayAPI.normalize($0.relay) + "/") } }

    // MARK: Clusters and members

    /// Makes a cluster with a new key. Its id once listed, or nil with `problem` saying why.
    func create(name: String, about: String) async -> String? {
        guard let account, let vault else { return notConnected() }
        let info = ClusterInfo(
            name: String(name.trimmed.prefix(120)), about: about.trimmed.isEmpty ? nil : String(about.trimmed.prefix(500)))
        do {
            let created = try await api.createCluster(info, profile: profile, for: account, vault: vault)
            await refresh()
            return created.id
        } catch {
            return fail(error)
        }
    }

    /// Joins with a pasted invite, or a link to the website that holds one.
    func join(_ text: String) async -> String? {
        guard let account, let vault else { return notConnected() }
        do {
            let invite = try Cluster.invite(in: text, relay: account.relay)
            let joined = try await api.joinCluster(invite, profile: profile, for: account, vault: vault)
            await refresh()
            return joined.id
        } catch {
            return fail(error)
        }
    }

    /// A member leaves, the owner deletes the cluster for everyone.
    func leave(_ clusterId: String) async -> Bool {
        guard let account, let board = boards[clusterId] else { return false }
        do {
            if board.isOwner {
                try await api.deleteCluster(clusterId, of: account)
            } else {
                try await api.leaveCluster(clusterId, of: account)
            }
            send?(["t": "cluster_unsubscribe", "clusterId": clusterId])
            boards[clusterId] = nil
            forget(clusterId)
            await refresh()
            return true
        } catch {
            fail(error)
            return false
        }
    }

    /// The owner: a link for up to 20 people over a week, with the cluster key it holds now.
    func invite(_ clusterId: String) async -> String? {
        guard let account, let board = boards[clusterId] else { return nil }
        let keyring = board.keyring
        guard let key = keyring.key(keyring.version) else {
            boards[clusterId]?.problem = String(localized: "The cluster is still opening: try again in a moment.")
            return nil
        }
        do {
            let created = try await api.createClusterInvite(clusterId, uses: 20, hours: 168, for: account)
            return ClusterInvite(relay: account.relay, cluster: clusterId, token: created.token, key: key, version: keyring.version).link
        } catch {
            boards[clusterId]?.problem = message(of: error)
            return nil
        }
    }

    func invites(_ clusterId: String) async -> [ClusterInviteSummary] {
        guard let account else { return [] }
        do {
            return try await api.clusterInvites(clusterId, of: account)
        } catch {
            boards[clusterId]?.problem = message(of: error)
            return []
        }
    }

    func revoke(invite inviteId: String, cluster clusterId: String) async -> Bool {
        guard let account else { return false }
        do {
            try await api.revokeClusterInvite(inviteId, cluster: clusterId, of: account)
            return true
        } catch {
            boards[clusterId]?.problem = message(of: error)
            return false
        }
    }

    /// This member's name in one cluster, sealed with its latest key.
    func rename(_ name: String, in clusterId: String) {
        let name = String(name.trimmed.prefix(80))
        guard !name.isEmpty, let board = boards[clusterId] else { return }
        seal(clusterId) {
            ["t": "cluster_profile", "clusterId": clusterId, "profile": try board.vault.seal(ClusterMemberProfile(name: name))]
        }
    }

    /// The owner sets the clock, over the revision this member saw: a stale one comes back as a conflict.
    func setClock(_ clock: ClusterClock, in clusterId: String) -> Bool {
        guard let board = boards[clusterId], board.isOwner, board.state != nil else { return false }
        return seal(clusterId) {
            ["t": "cluster_doc", "clusterId": clusterId, "name": "clock", "rev": board.clockRev, "blob": try board.vault.seal(clock)]
        }
    }

    // MARK: The leaderboard

    func sharesHero(in clusterId: String) -> Bool {
        guard let accountId else { return false }
        return sharing[clusterId] ?? boards[clusterId]?.sharesHero(account: accountId) ?? false
    }

    /// Puts this member's Tonton on the cluster's leaderboard, or takes it off: its entry follows its hero from then on.
    func shareHero(_ shared: Bool, in clusterId: String) {
        sharing[clusterId] = shared
        keepHero(in: clusterId)
    }

    private func keepHeroes() {
        for clusterId in boards.keys { keepHero(in: clusterId) }
    }

    /// Writes this member's entry when what the board says differs from its hero, or from its choice.
    private func keepHero(in clusterId: String) {
        guard let accountId, let board = boards[clusterId], board.state != nil else { return }
        let shared = sharesHero(in: clusterId)
        let rpg = RPGStore.shared
        // The hero must be the committed one: an entry is never written from an empty hero still loading.
        guard !shared || rpg.ready else { return }
        switch board.share(shared ? rpg.hero : nil, account: accountId) {
        case .write(let rev, let next):
            seal(clusterId) {
                [
                    "t": "cluster_doc", "clusterId": clusterId, "name": ClusterHeroes.document, "rev": rev,
                    "blob": try board.vault.seal(next),
                ]
            }
        case .unchanged:
            // The board says what was asked: from now on it is the board that says it.
            sharing[clusterId] = nil
        case .unreadable:
            boards[clusterId]?.problem = String(localized: "The leaderboard does not open with the keys you hold yet: nothing was changed.")
        case .notOpen:
            break
        }
    }

    // MARK: This account's sessions

    /// The clusters a session of this account is in, with its place in each.
    func memberships(of sessionId: String) -> [(board: ClusterBoard, session: ClusterState.Session)] {
        guard let accountId else { return [] }
        return ordered.compactMap { board in board.session(sessionId, of: accountId).map { (board, $0) } }
    }

    /// The clusters it can be put in: open, and it is not in them yet.
    func joinable(for sessionId: String) -> [ClusterBoard] {
        guard let accountId else { return [] }
        return ordered.filter { $0.state != nil && $0.session(sessionId, of: accountId) == nil }
    }

    func choice(for sessionId: String, in clusterId: String) -> ClusterSessionChoice {
        choices.choice(cluster: clusterId, session: sessionId)
    }

    /// Puts the session in, or sends it a new delivery: its agent gets the order sealed with the account key, with the
    /// cluster key this member holds now; the cluster sees its profile, sealed with the cluster key.
    func put(_ session: SessionSummary, in clusterId: String, choice: ClusterSessionChoice) throws {
        guard let board = boards[clusterId], let vault, let send else {
            throw RelayError(message: String(localized: "Connect to the relay to put a session in a cluster."))
        }
        let keyring = board.keyring
        guard let key = keyring.key(keyring.version) else {
            throw RelayError(message: String(localized: "The cluster is still opening: try again in a moment."))
        }
        let order = try vault.sealClusterSessionOrder(
            clusterId: clusterId, sessionId: session.id, key: key, version: keyring.version, delivery: choice.delivery,
            liveWithoutPrompts: choice.liveWithoutPrompts)
        let profile = try board.vault.seal(ClusterModel.profile(of: session))
        send(["t": "cluster_join_session", "clusterId": clusterId, "sessionId": session.id, "order": order, "profile": profile])
        remember(choice, for: session.id, in: clusterId)
    }

    /// The delivery a session gets once put in, chosen before.
    func setChoice(_ choice: ClusterSessionChoice, for sessionId: String, in clusterId: String) {
        remember(choice, for: sessionId, in: clusterId)
    }

    func takeOut(_ sessionId: String, of clusterId: String) {
        send?(["t": "cluster_leave_session", "clusterId": clusterId, "sessionId": sessionId])
    }

    /// What went wrong putting a session in, shown on the cluster's page.
    func report(_ error: Error, in clusterId: String) {
        boards[clusterId]?.problem = error.localizedDescription
    }

    // MARK: Inside

    private var profile: ClusterMemberProfile? {
        let name = memberName.trimmed
        return name.isEmpty ? nil : ClusterMemberProfile(name: String(name.prefix(80)))
    }

    private func remember(_ choice: ClusterSessionChoice, for sessionId: String, in clusterId: String) {
        choices = choices.setting(choice, cluster: clusterId, session: sessionId)
        UserDefaults.standard.set(choices.data, forKey: Self.choicesKey)
    }

    private func forget(_ clusterId: String) {
        choices = choices.without(cluster: clusterId)
        UserDefaults.standard.set(choices.data, forKey: Self.choicesKey)
    }

    /// After a rotation, this member's public key under the new version, so the owner can wrap the next one for it.
    private func republish(_ board: ClusterBoard) {
        guard let account, let vault, let send else { return }
        let done = "\(board.id)/\(board.keyring.version)"
        guard !republished.contains(done), let keys = board.republished(account: account.accountId, vault: vault) else { return }
        republished.insert(done)
        send(["t": "cluster_member_key", "clusterId": board.id, "publicKey": keys.publicKey, "secret": keys.secret])
    }

    /// Seals and sends a message for one cluster, keeping why it could not.
    @discardableResult
    private func seal(_ clusterId: String, _ message: () throws -> [String: Any]) -> Bool {
        guard let send else {
            boards[clusterId]?.problem = String(localized: "Not connected to the relay: nothing was changed.")
            return false
        }
        do {
            send(try message())
            return true
        } catch {
            Logger.app.error("cluster \(clusterId): \(error.localizedDescription)")
            return false
        }
    }

    private func notConnected() -> String? {
        problem = String(localized: "Connect to the relay to use clusters.")
        return nil
    }

    @discardableResult
    private func fail(_ error: Error) -> String? {
        problem = message(of: error)
        return nil
    }

    private func message(of error: Error) -> String {
        if Cluster.isUnsupported(error) {
            supported = false
            return Cluster.unsupported
        }
        Logger.app.error("clusters: \(error.localizedDescription)")
        return error.localizedDescription
    }
}

extension String {
    fileprivate var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
