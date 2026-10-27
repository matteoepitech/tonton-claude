import Foundation
import Observation
import TontonCore

/// The account's sessions as the phone sees them, through the relay's socket while the app is open. Once it goes to
/// the background the socket closes, and a relay with an APNs key takes over the Live Activity and the alerts.
@MainActor @Observable
final class PhoneStore {
    private(set) var account: Account?
    private(set) var feed = RelayFeed()
    private(set) var connection: ConnectionState = .notConfigured
    /// The conversations pushed on the navigation stack. The relay streams the last one.
    var path: [String] = [] {
        didSet { if path.last != oldValue.last { subscribe() } }
    }
    /// Shown as an alert, then cleared.
    var lastError: String?
    let push = PushRegistrar()
    let island = IslandController()

    @ObservationIgnored private let socket = RelaySocket()
    @ObservationIgnored private let api = RelayAPI()
    @ObservationIgnored private var vault: SessionVault?
    @ObservationIgnored private var foreground = false

    init() {
        account = SharedAccount.load()
        vault = (try? account?.symmetricKey()).map { SessionVault(key: $0) }
        socket.onState = { [weak self] state in self?.socketChanged(state) }
        socket.onMessage = { [weak self] message in self?.handle(message) }
        island.onToken = { [weak self] token in self?.push.activityToken = token }
        island.onStartToken = { [weak self] token in self?.push.activityStartToken = token }
        push.account = account
        island.observe()
    }

    var openSession: String? { path.last }

    // MARK: Lifecycle

    func activate() {
        foreground = true
        guard let account else { return }
        socket.connect(account, device: push.deviceId)
        Task { await push.refreshAuthorization() }
    }

    /// The relay takes over while the app is away: it sees the socket close.
    func deactivate() {
        foreground = false
        socket.disconnect(to: .paused)
        Task { await island.show(feed.island, relayPushes: push.relayPushes == true, foreground: false) }
    }

    func signIn(_ account: Account) async throws {
        try await api.verify(account)
        guard SharedAccount.save(account) else { throw RelayError(message: "Could not keep the account in the Keychain.") }
        if let previous = self.account, previous != account { await push.signOut(previous) }
        self.account = account
        vault = (try? account.symmetricKey()).map { SessionVault(key: $0) }
        feed = RelayFeed()
        path = []
        push.account = account
        if foreground { socket.connect(account, device: push.deviceId) }
        await push.requestAuthorization()
    }

    func signOut() async {
        socket.disconnect(to: .notConfigured)
        if let account { await push.signOut(account) }
        await island.end()
        SharedAccount.save(nil)
        account = nil
        vault = nil
        feed = RelayFeed()
        path = []
    }

    /// Pull to refresh: a new socket and a new snapshot.
    func reconnect() {
        guard let account, foreground else { return }
        socket.connect(account, device: push.deviceId)
    }

    // MARK: Links

    func open(_ url: URL) {
        switch PhoneLink(url: url) {
        case .signIn(let account):
            Task {
                do { try await signIn(account) } catch { lastError = error.localizedDescription }
            }
        case .session(let id): show(id)
        case nil: break
        }
    }

    func show(_ sessionId: String) {
        guard account != nil, path.last != sessionId else { return }
        path = [sessionId]
    }

    // MARK: Relay

    private func socketChanged(_ state: ConnectionState) {
        connection = state
        guard state == .connected else { return }
        subscribe()
        Task { await push.sync() }
    }

    private func handle(_ message: RelayMessage) {
        guard let vault else { return }
        feed.apply(message, vault: vault)
        if let error = feed.lastError {
            lastError = error
            feed.clearError()
        }
        switch message {
        case .snapshot, .session, .removed:
            Task { await island.show(feed.island, relayPushes: push.relayPushes == true, foreground: foreground) }
        default:
            break
        }
    }

    private func subscribe() {
        guard connection == .connected else { return }
        socket.send(["t": "subscribe", "sessionId": openSession ?? NSNull()])
    }

    // MARK: Commands

    func send(_ text: String, to sessionId: String) {
        guard let payload = try? vault?.sealPrompt(text: text, images: []) else { return }
        socket.send(["t": "prompt", "sessionId": sessionId, "payload": payload])
    }

    func run(_ command: SessionCommandName, in sessionId: String) {
        guard let payload = try? vault?.sealCommand(command, for: sessionId) else { return }
        socket.send(["t": "prompt", "sessionId": sessionId, "payload": payload])
    }

    func answer(_ request: PermissionRequest, allow: Bool, in sessionId: String) {
        socket.send(["t": "verdict", "sessionId": sessionId, "requestId": request.requestId, "behavior": allow ? "allow" : "deny"])
    }

    /// What "Allow for this session" offers, when the session's agent keeps such rules, like on the Mac.
    func sessionRule(for request: PermissionRequest, in session: SessionSummary) -> SessionRule? {
        guard feed.machines.first(where: { $0.id == session.machineId })?.keepsSessionRules == true else { return nil }
        return SessionRule.suggested(tool: request.toolName, inputPreview: request.inputPreview)
    }

    func allowForSession(_ request: PermissionRequest, rule: SessionRule, in sessionId: String) {
        guard let sealed = try? vault?.sealSessionRules(rule.rules, for: sessionId, requestId: request.requestId) else { return }
        socket.send(["t": "verdict", "sessionId": sessionId, "requestId": request.requestId, "behavior": "allow", "rule": sealed])
    }

    /// Removes a closed session from the list, for every app of the account.
    func dismiss(_ sessionId: String) {
        socket.send(["t": "dismiss", "sessionId": sessionId])
    }
}
