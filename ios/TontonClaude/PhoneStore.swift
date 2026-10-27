import Foundation
import Observation
import TontonCore
import UserNotifications

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
    /// The requests waiting when the relay last spoke: alerts of the others can go.
    @ObservationIgnored private var lastPending: Set<String> = []
    /// Answers from alerts under way, which keep the socket open in the background.
    @ObservationIgnored private var answering = 0

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
        if case .session(let id) = PhoneLink(url: url) { show(id) }
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
            let pending = Set(feed.sessions.flatMap { $0.pendingPermissions.map(\.requestId) })
            if pending != lastPending {
                lastPending = pending
                Task { await clearAnsweredAlerts() }
            }
        default:
            break
        }
    }

    /// Alerts of requests answered elsewhere, on the Mac say, go away: from the phone and from a watch it mirrors to.
    private func clearAnsweredAlerts() async {
        guard feed.snapshots > 0 else { return }
        let center = UNUserNotificationCenter.current()
        let answered = await center.deliveredNotifications().filter { notification in
            PermissionPush(userInfo: notification.request.content.userInfo).map { feed.standing(of: $0) == .gone } ?? false
        }
        if !answered.isEmpty { center.removeDeliveredNotifications(withIdentifiers: answered.map(\.request.identifier)) }
    }

    private func subscribe() {
        guard connection == .connected else { return }
        // Relays that know `latestFirst` send the end of the conversation at once, then all of it.
        socket.send(["t": "subscribe", "sessionId": openSession ?? NSNull(), "latestFirst": true])
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

    // MARK: Answers from alerts

    /// Allow or Deny tapped on an alert, on the phone or on an Apple Watch, maybe with the app woken in the background.
    /// It connects when it has to, checks the request still waits, answers it and waits for the relay to confirm. When it
    /// cannot, a notification says so: nothing else would.
    func answer(_ alert: PermissionPush, with action: PermissionAction) async {
        guard let account else { return }
        let current = connection == .connected
        let seen = feed.snapshots
        // Another answer may be connecting already.
        if !current && connection != .connecting { socket.connect(account, device: push.deviceId) }
        answering += 1
        defer {
            answering -= 1
            // Back in the background, the relay takes the Live Activity over again.
            if answering == 0 && !foreground { socket.disconnect(to: .paused) }
        }
        if !current, await !until({ self.feed.snapshots > seen }) { return await couldNotAnswer(alert) }
        switch feed.standing(of: alert) {
        case .gone: return
        case .unreachable: return await couldNotAnswer(alert)
        case .pending: break
        }
        socket.send(["t": "verdict", "sessionId": alert.sessionId, "requestId": alert.requestId, "behavior": action.rawValue])
        if await !until({ self.feed.standing(of: alert) == .gone }) { await couldNotAnswer(alert) }
    }

    /// Whether the condition holds within a few seconds: the system gives an action about thirty in all.
    private func until(_ condition: () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(8)
        while ContinuousClock.now < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(150))
        }
        return condition()
    }

    private func couldNotAnswer(_ alert: PermissionPush) async {
        let content = UNMutableNotificationContent()
        content.title = vault?.alert(for: alert)?.title ?? "Permission request"
        content.body = "Not answered: the relay or the session could not be reached. Open Tonton Claude to answer."
        content.threadIdentifier = alert.sessionId
        // Without the sealed blobs: opening it only needs the session.
        content.userInfo = ["tonton": ["sessionId": alert.sessionId, "requestId": alert.requestId]]
        let request = UNNotificationRequest(identifier: "unanswered-\(alert.requestId)", content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }
}
