import Foundation
import OSLog
import TontonCore

/// The account's pools in the notch (docs/pools.md): listed when the app connects, followed on the relay socket, opened
/// with the pool keys this member holds. It puts the account's sessions in a pool and takes them out, and hands back a
/// task its owner refused. Pools are made and joined on the relay's website; the notch shows the account's.
@MainActor
final class PoolStore: ObservableObject {
    static let shared = PoolStore()

    /// By pool id.
    @Published private(set) var boards: [String: PoolBoard] = [:]
    /// Why the account's pools are not shown, when the relay could not list them.
    @Published private(set) var problem: String?

    private var account: Account?
    private var vault: SessionVault?
    private var send: (([String: Any]) -> Void)?
    private let api = RelayAPI()

    /// The pools, by name.
    var ordered: [PoolBoard] { boards.values.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending } }

    // MARK: Connection

    /// The socket is up: lists the account's pools and follows each one.
    func connected(account: Account, vault: SessionVault, send: @escaping ([String: Any]) -> Void) {
        self.account = account
        self.vault = vault
        self.send = send
        // The relay forgot what a dropped socket followed: the pools already known are followed again.
        for poolId in boards.keys { send(["t": "pool_subscribe", "poolId": poolId]) }
        Task { await refresh() }
    }

    /// Another account, signed out, or the socket went down: nothing of the previous one stays.
    func reset() {
        (account, vault, send) = (nil, nil, nil)
        boards = [:]
        problem = nil
    }

    /// Lists the pools again: a pool joined on the website shows up.
    func refresh() async {
        guard let account, let vault else { return }
        do {
            let summaries = try await api.pools(of: account)
            guard self.account == account else { return }
            problem = nil
            var next: [String: PoolBoard] = [:]
            for summary in summaries {
                // A pool already followed keeps its state; a new one is followed from now on.
                if let known = boards[summary.id] {
                    next[summary.id] = known
                } else if let board = PoolBoard(summary: summary, vault: vault) {
                    next[summary.id] = board
                    send?(["t": "pool_subscribe", "poolId": summary.id])
                }
            }
            boards = next
        } catch let error as RelayError where error.message == "not found" {
            problem = String(localized: "This relay is too old for pools: it needs 0.8.0 or later.")
        } catch {
            Logger.app.error("pools: \(error.localizedDescription)")
        }
    }

    func apply(_ update: PoolUpdate) {
        guard let account, let vault else { return }
        let poolId = PoolState.poolId(of: update)
        guard var board = boards[poolId] else { return }
        if board.take(update, account: account.accountId, vault: vault) {
            boards[poolId] = board
        } else {
            boards[poolId] = nil
        }
        if case .error(_, let message) = update { Logger.app.error("pool \(poolId): \(message)") }
    }

    // MARK: Reading

    /// The pool a session works in, with its place in it. The first one when it is in several.
    func membership(of sessionId: String) -> (board: PoolBoard, state: PoolState, session: PoolState.Session)? {
        for board in ordered {
            if let state = board.state, let session = state.session(sessionId) { return (board, state, session) }
        }
        return nil
    }

    /// The pools a session of this account can join: its role lets it post.
    var joinable: [PoolBoard] { ordered.filter { $0.summary.role != .viewer && $0.state != nil } }

    func websiteURL(of poolId: String) -> URL? {
        account.flatMap { PoolLinks.website(relay: $0.relay, pool: poolId) }
    }

    // MARK: Changing

    /// Puts the session in the pool: its agent takes the order, sealed with the account key, and works for the pool.
    func join(_ session: SessionSummary, pool poolId: String, form: PoolJoinForm) throws {
        guard let board = boards[poolId], let vault, let send else {
            throw RelayError(message: String(localized: "Connect to the relay to put a session in a pool."))
        }
        let keyring = board.keyring
        guard let key = keyring.key(keyring.version) else { throw RelayError(message: String(localized: "This pool's key is missing.")) }
        let order = try vault.sealPoolSessionOrder(
            poolId: poolId, sessionId: session.id, key: key, version: keyring.version, autoStart: form.autoStart)
        let profile = try board.poolVault.seal(form.profile(for: session))
        send(["t": "pool_join_session", "poolId": poolId, "sessionId": session.id, "order": order, "profile": profile])
    }

    func leave(_ sessionId: String, pool poolId: String) {
        send?(["t": "pool_leave_session", "poolId": poolId, "sessionId": sessionId])
    }

    /// The owner does not want the session to take this task: it goes back to the board, for the orchestrator to give to
    /// another session.
    func refuse(_ item: PoolState.Task, pool poolId: String) {
        guard let board = boards[poolId], let task = item.task, let send else { return }
        do {
            let vault = board.poolVault
            let blob = try vault.seal(PoolState.refused(task))
            send(["t": "pool_task", "poolId": poolId, "id": item.id, "rev": item.rev, "blob": blob])
            let event = try vault.seal(PoolEventBody(kind: "refused", text: task.title, taskId: item.id))
            send(["t": "pool_event", "poolId": poolId, "id": Self.newItemId(), "blob": event])
        } catch {
            Logger.app.error("pool \(poolId): \(error.localizedDescription)")
        }
    }

    /// 12 random bytes in base64url, like shared/pool.ts makes them.
    private static func newItemId() -> String {
        Data((0..<12).map { _ in UInt8.random(in: 0...255) }).base64URLEncodedString()
    }
}
