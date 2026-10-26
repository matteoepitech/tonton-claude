import Combine
import Foundation
import TontonCore

/// Live state of the account's sessions and machines, fed by the relay socket and decrypted with the account key, plus
/// the sessions of this Mac read from Claude Code's files, which need neither an account nor an agent.
@MainActor
final class SessionStore: ObservableObject {
    /// From the relay.
    @Published private var relaySessions: [SessionSummary] = []
    /// From this Mac's files. When an agent on this Mac reports the same session, its copy wins: it can chat.
    @Published private var localSessions: [SessionSummary] = []
    /// Local sessions removed from the list by hand.
    @Published private var dismissedLocal: Set<String> = []
    var sessions: [SessionSummary] { Self.merged(relaySessions, localSessions, dismissedLocal) }
    /// `sessions` as it changes.
    var sessionsPublisher: AnyPublisher<[SessionSummary], Never> {
        $relaySessions.combineLatest($localSessions, $dismissedLocal).map(Self.merged).eraseToAnyPublisher()
    }

    private static func merged(_ relay: [SessionSummary], _ local: [SessionSummary], _ dismissed: Set<String>) -> [SessionSummary] {
        let relayIds = Set(relay.map(\.id))
        return sorted(relay + local.filter { !relayIds.contains($0.id) && !dismissed.contains($0.id) })
    }
    @Published private(set) var machines: [MachineInfo] = []
    /// Machines are offered the agent released with this app. Development builds (0.0.0) offer nothing.
    let agentVersion: String? = {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        return version == "0.0.0" ? nil : version
    }()
    /// Machines asked to update that have not answered yet.
    @Published private(set) var updatingMachines: Set<String> = []
    @Published private(set) var updateErrors: [String: String] = [:]
    @Published private var relayEntries: [String: [Entry]] = [:]
    @Published private var localEntries: [String: [Entry]] = [:]
    /// The relay's history once it arrived, this Mac's transcript until then.
    var entries: [String: [Entry]] { localEntries.merging(relayEntries) { _, relay in relay } }
    @Published private(set) var connection: ConnectionState = .notConfigured
    @Published private(set) var latency: RelayLatency?
    @Published var selectedId: String? {
        didSet { if selectedId != oldValue { subscribe() } }
    }
    @Published var lastError: String?

    /// A session started needing the user: permission, question or error.
    let attention = PassthroughSubject<SessionSummary, Never>()
    /// A session went from working to done.
    let finished = PassthroughSubject<SessionSummary, Never>()
    /// Sessions a usage limit stopped, the moment it resets.
    let limitLifted = PassthroughSubject<[SessionSummary], Never>()
    /// Sessions that get `continue` when a usage limit that stopped them resets. Kept while the app runs.
    @Published private(set) var autoContinue: Set<String> = []
    /// Requests can still be refused right at the reset: wait a little, as Claude Code does.
    private static let continueDelay: Duration = .seconds(30)
    /// The user allowed a permission request from the notch.
    let approved = PassthroughSubject<Void, Never>()
    /// The user sent a message from the notch.
    let sent = PassthroughSubject<Void, Never>()

    private let settings: AppSettings
    private let socket = RelaySocket()
    private let api = RelayAPI()
    private var vault: SessionVault?
    private let localWatcher = LocalSessionWatcher()
    /// Cost and tokens per day, for Settings › Usage.
    private(set) lazy var usage = UsageRecorder(sessions: sessionsPublisher, settings: settings)
    /// One per reset time of the sessions a usage limit stopped.
    private var resetTimers: [Date: Task<Void, Never>] = [:]
    private var subscriptions = Set<AnyCancellable>()

    init(settings: AppSettings) {
        self.settings = settings
        socket.onState = { [weak self] state in self?.socketStateChanged(state) }
        socket.onMessage = { [weak self] message in self?.handle(message) }
        socket.onLatency = { [weak self] latency in self?.latency = latency }
        // The join secret does not change the connection.
        settings.$account.map { $0.map { [$0.relay, $0.token, $0.key] } }.removeDuplicates()
            .combineLatest(settings.$connectionEnabled)
            .dropFirst()
            .debounce(for: .milliseconds(300), scheduler: RunLoop.main)
            .sink { [weak self] _ in self?.connect() }
            .store(in: &subscriptions)
        localWatcher.onChange = { [weak self] sessions, entries in self?.localChanged(sessions, entries) }
        localWatcher.start()
        sessionsPublisher.combineLatest(settings.$hiddenMachines)
            .sink { [weak self] sessions, hidden in self?.scheduleLimitResets(sessions.filter { !hidden.contains($0.machine) }) }
            .store(in: &subscriptions)
        limitLifted.sink { [weak self] sessions in self?.continueAfterLimit(sessions) }.store(in: &subscriptions)
        _ = usage
    }

    func toggleAutoContinue(_ sessionId: String) {
        if autoContinue.contains(sessionId) { autoContinue.remove(sessionId) } else { autoContinue.insert(sessionId) }
    }

    /// Sends `continue` through the chat channel to the freed sessions that asked for it.
    private func continueAfterLimit(_ lifted: [SessionSummary]) {
        guard !LimitResets.toContinue(lifted, optedIn: autoContinue).isEmpty else { return }
        Task { [weak self] in
            try? await Task.sleep(for: Self.continueDelay)
            guard let self else { return }
            // Read again: the user may have changed their mind, or the session closed, in the meantime.
            let current = lifted.compactMap { session in self.sessions.first { $0.id == session.id } }
            for id in LimitResets.toContinue(current, optedIn: self.autoContinue) { self.sendPrompt("continue", images: [], to: id) }
        }
    }

    /// Keeps a timer for each reset time of the stopped sessions. Timers already due are left to fire: a session update in
    /// the same instant must not swallow the alert.
    private func scheduleLimitResets(_ sessions: [SessionSummary]) {
        let now = Date()
        let resets = LimitResets.upcoming(sessions, at: now)
        for (reset, timer) in resetTimers where !resets.contains(reset) && reset > now {
            timer.cancel()
            resetTimers[reset] = nil
        }
        for reset in resets where resetTimers[reset] == nil {
            resetTimers[reset] = Task { [weak self] in
                try? await Task.sleep(for: .seconds(reset.timeIntervalSinceNow))
                guard !Task.isCancelled, let self else { return }
                self.resetTimers[reset] = nil
                let lifted = LimitResets.lifted(self.visibleSessions, at: reset)
                if !lifted.isEmpty { self.limitLifted.send(lifted) }
            }
        }
    }

    // MARK: Derived state

    var selected: SessionSummary? { visibleSessions.first { $0.id == selectedId } }

    /// Sessions shown in the notch: hidden machines and long-finished sessions are left out.
    var visibleSessions: [SessionSummary] {
        let hours = settings.hideFinishedAfterHours
        let cutoff = hours > 0 ? Date().addingTimeInterval(-Double(hours) * 3600) : nil
        return sessions.filter { session in
            if settings.hiddenMachines.contains(session.machine) { return false }
            if let cutoff, !session.status.isLive, session.lastActivity < cutoff { return false }
            return true
        }
    }

    /// The machine id of the agent on this Mac, read again from its config whenever the machines change.
    @Published private(set) var thisMac: String?

    func isOnThisMac(_ session: SessionSummary) -> Bool { thisMachines.contains(session.machineId) }

    /// This Mac's sessions, whether they come from its agent or straight from its files.
    var thisMachines: Set<String> { Set([LocalSessions.machineId] + [thisMac].compactMap { $0 }) }

    /// The list as the notch shows it, pinned sessions first, then this Mac's.
    var sections: [SessionSection] { SessionLayout.sections(visibleSessions, pinned: settings.pinnedSessions, thisMac: thisMachines) }
    var orderedSessions: [SessionSummary] {
        SessionLayout.ordered(visibleSessions, pinned: settings.pinnedSessions, thisMac: thisMachines)
    }

    func togglePin(_ sessionId: String) {
        if settings.pinnedSessions.contains(sessionId) {
            settings.pinnedSessions.removeAll { $0 == sessionId }
        } else {
            settings.pinnedSessions.append(sessionId)
        }
    }

    var attentionCount: Int { visibleSessions.filter(\.status.needsAttention).count }

    // MARK: Connection

    func connect() {
        relaySessions = []
        machines = []
        thisMac = nil
        relayEntries = [:]
        updatingMachines = []
        updateErrors = [:]
        guard settings.connectionEnabled else {
            socket.disconnect(to: .paused)
            return
        }
        guard let account = settings.account, let key = try? account.symmetricKey() else {
            vault = nil
            socket.disconnect(to: .notConfigured)
            return
        }
        vault = SessionVault(key: key)
        socket.connect(account)
    }

    private func socketStateChanged(_ state: ConnectionState) {
        connection = state
        if state == .connected { subscribe() }
    }

    private func handle(_ message: RelayMessage) {
        guard let vault else { return }
        switch message {
        case .snapshot(let wireSessions, let wireMachines):
            machines = vault.machines(wireMachines)
            thisMac = settings.account.flatMap { LocalAgent.machineId(for: $0.accountId) }
            relaySessions = Self.sorted(wireSessions.map { vault.session($0, machines: machines) })
            // The snapshot lists every session the relay still has: pins of the others can go.
            let pins = settings.pinnedSessions.filter { id in sessions.contains { $0.id == id } }
            if pins != settings.pinnedSessions { settings.pinnedSessions = pins }
            if selectedId == nil || !sessions.contains(where: { $0.id == selectedId }) { selectedId = preferredSelection() }
        case .session(let wire):
            update(vault.session(wire, machines: machines))
        case .machines(let wireMachines):
            machines = vault.machines(wireMachines)
            thisMac = settings.account.flatMap { LocalAgent.machineId(for: $0.accountId) }
        case .removed(let sessionId):
            relaySessions.removeAll { $0.id == sessionId }
            relayEntries[sessionId] = nil
            settings.pinnedSessions.removeAll { $0 == sessionId }
            if selectedId == sessionId { selectedId = preferredSelection() }
        case .history(let sessionId, let wireEntries):
            relayEntries[sessionId] = vault.entries(wireEntries)
        case .entries(let sessionId, let wireEntries):
            relayEntries[sessionId, default: []].append(contentsOf: vault.entries(wireEntries))
        case .error(let text):
            lastError = text
        case .agentUpdate(let machineId, let ok, let reason, let detail):
            updateFinished(machineId, ok: ok, reason: reason, detail: vault.detailText(detail))
        case .unknown:
            break
        }
    }

    private func update(_ session: SessionSummary) {
        let previous = sessions.first { $0.id == session.id }
        if let index = relaySessions.firstIndex(where: { $0.id == session.id }) {
            relaySessions[index] = session
        } else {
            relaySessions.append(session)
        }
        if selectedId == nil { selectedId = session.id }
        notify(session, previous: previous)
    }

    private func localChanged(_ sessions: [SessionSummary], _ entries: [String: [Entry]]) {
        let relayIds = Set(relaySessions.map(\.id))
        let previous = Dictionary(localSessions.map { ($0.id, $0) }) { first, _ in first }
        localSessions = sessions
        localEntries = entries
        for session in sessions where !relayIds.contains(session.id) && !dismissedLocal.contains(session.id) {
            notify(session, previous: previous[session.id])
        }
        if selectedId == nil || !self.sessions.contains(where: { $0.id == selectedId }) { selectedId = preferredSelection() }
    }

    /// Alerts and sounds for a session that started needing the user, or finished working.
    private func notify(_ session: SessionSummary, previous: SessionSummary?) {
        guard !settings.hiddenMachines.contains(session.machine) else { return }
        let changed = previous?.status != session.status || previous?.pendingPermissions != session.pendingPermissions
        if session.status.needsAttention && changed { attention.send(session) }
        if previous?.status == .working && session.status == .idle { finished.send(session) }
    }

    private static func sorted(_ list: [SessionSummary]) -> [SessionSummary] {
        list.sorted { a, b in
            a.status.isLive != b.status.isLive ? a.status.isLive : a.lastActivity > b.lastActivity
        }
    }

    private func preferredSelection() -> String? {
        (sessions.first { $0.status.needsAttention } ?? sessions.first { $0.status.isLive } ?? sessions.first)?.id
    }

    // MARK: Session commands

    private func subscribe() {
        guard connection == .connected else { return }
        socket.send(["t": "subscribe", "sessionId": selectedId ?? NSNull()])
    }

    func sendPrompt(_ text: String, images: [OutgoingImage], to sessionId: String) {
        guard let payload = try? vault?.sealPrompt(text: text, images: images) else { return }
        socket.send(["t": "prompt", "sessionId": sessionId, "payload": payload])
        sent.send()
    }

    func answer(_ request: PermissionRequest, allow: Bool, in sessionId: String) {
        socket.send(["t": "verdict", "sessionId": sessionId, "requestId": request.requestId, "behavior": allow ? "allow" : "deny"])
        if allow { approved.send() }
    }

    func dismiss(_ sessionId: String) {
        guard relaySessions.contains(where: { $0.id == sessionId }) else {
            dismissedLocal.insert(sessionId)
            settings.pinnedSessions.removeAll { $0 == sessionId }
            if selectedId == sessionId { selectedId = preferredSelection() }
            return
        }
        socket.send(["t": "dismiss", "sessionId": sessionId])
    }

    // MARK: Agent updates

    func updateAgent(_ machine: MachineInfo) {
        guard let latest = agentVersion, !updatingMachines.contains(machine.id),
            let order = try? vault?.sealUpdateOrder(version: latest)
        else { return }
        updatingMachines.insert(machine.id)
        updateErrors[machine.id] = nil
        socket.send(["t": "update_agent", "machineId": machine.id, "order": order])
        // No answer comes back if the session running the update closes in the middle.
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(180))
            self?.updatingMachines.remove(machine.id)
        }
    }

    private func updateFinished(_ machineId: String, ok: Bool, reason: String?, detail: String?) {
        updatingMachines.remove(machineId)
        guard !ok else { return }
        let name = machines.first { $0.id == machineId }?.name ?? "the machine"
        let message =
            switch reason {
            case "offline": "\(name) is offline. Check that it is on and that the Tonton Claude agent runs there."
            case "unsupported": "The agent on \(name) is too old to update itself. Run the install command there once more."
            default: "Could not update \(name): \(detail ?? "unknown error")."
            }
        updateErrors[machineId] = message
        lastError = message
    }

    /// The command that updates an agent too old to update itself: the install script, without a connection code.
    func manualUpdateCommand(for machine: MachineInfo) -> String {
        let platform = machine.platform ?? sessions.first { $0.machineId == machine.id }?.platform
        return platform == "win32" ? InstallCommand.windows() : InstallCommand.unix()
    }

    // MARK: Account

    func createAccount(on relay: String) async throws {
        let account = try await api.createAccount(on: relay)
        settings.serverURL = account.relay
        settings.account = account
    }

    func restore(_ account: Account) async throws {
        try await api.verify(account)
        settings.serverURL = account.relay
        settings.account = account
    }

    /// Asks the relay for the account token the first time. An account whose token was made on another Mac has to
    /// regenerate it here.
    func createMachineToken() async throws {
        guard let account = settings.account, account.joinSecret == nil else { return }
        settings.account = account.with(joinSecret: try await api.joinSecret(for: account, regenerate: false))
    }

    /// A new token and a new encryption key: every machine is signed out until it gets the new token, and other Macs
    /// signed in to the account need the new recovery key.
    func regenerateMachineToken() async throws {
        guard let account = settings.account else { return }
        let secret = try await api.joinSecret(for: account, regenerate: true)
        settings.account = account.with(key: E2E.newKey(), joinSecret: secret)
    }

    func revoke(_ machine: MachineInfo) async throws {
        guard let account = settings.account else { return }
        try await api.revokeMachine(machine.id, of: account)
    }

    func deleteAccount() async throws {
        guard let account = settings.account else { return }
        try await api.deleteAccount(account)
        signOut()
    }

    func signOut() {
        settings.account = nil
    }
}
