import Combine
import Foundation
import TontonCore

/// Live state of the account's sessions and machines, fed by the relay socket and decrypted with the account key.
@MainActor
final class SessionStore: ObservableObject {
    @Published private(set) var sessions: [SessionSummary] = []
    @Published private(set) var machines: [MachineInfo] = []
    /// Machines are offered the agent released with this app. Development builds (0.0.0) offer nothing.
    let agentVersion: String? = {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        return version == "0.0.0" ? nil : version
    }()
    /// Machines asked to update that have not answered yet.
    @Published private(set) var updatingMachines: Set<String> = []
    @Published private(set) var updateErrors: [String: String] = [:]
    @Published private(set) var entries: [String: [Entry]] = [:]
    @Published private(set) var connection: ConnectionState = .notConfigured
    @Published var selectedId: String? {
        didSet { if selectedId != oldValue { subscribe() } }
    }
    @Published var lastError: String?

    /// A session started needing the user: permission, question or error.
    let attention = PassthroughSubject<SessionSummary, Never>()
    /// A session went from working to done.
    let finished = PassthroughSubject<SessionSummary, Never>()

    private let settings: AppSettings
    private let socket = RelaySocket()
    private let api = RelayAPI()
    private var vault: SessionVault?
    private var subscriptions = Set<AnyCancellable>()

    init(settings: AppSettings) {
        self.settings = settings
        socket.onState = { [weak self] state in self?.socketStateChanged(state) }
        socket.onMessage = { [weak self] message in self?.handle(message) }
        settings.$account.combineLatest(settings.$connectionEnabled)
            .dropFirst()
            .debounce(for: .milliseconds(300), scheduler: RunLoop.main)
            .sink { [weak self] _ in self?.connect() }
            .store(in: &subscriptions)
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

    var attentionCount: Int { visibleSessions.filter(\.status.needsAttention).count }

    var todayCost: Double {
        let startOfDay = Calendar.current.startOfDay(for: Date())
        return sessions.filter { $0.startedAt >= startOfDay }.compactMap(\.costUSD).reduce(0, +)
    }

    // MARK: Connection

    func connect() {
        sessions = []
        machines = []
        entries = [:]
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
            sessions = sorted(wireSessions.map { vault.session($0, machines: machines) })
            if selectedId == nil || !sessions.contains(where: { $0.id == selectedId }) { selectedId = preferredSelection() }
        case .session(let wire):
            update(vault.session(wire, machines: machines))
        case .machines(let wireMachines):
            machines = vault.machines(wireMachines)
        case .removed(let sessionId):
            sessions.removeAll { $0.id == sessionId }
            entries[sessionId] = nil
            if selectedId == sessionId { selectedId = preferredSelection() }
        case .history(let sessionId, let wireEntries):
            entries[sessionId] = vault.entries(wireEntries)
        case .entries(let sessionId, let wireEntries):
            entries[sessionId, default: []].append(contentsOf: vault.entries(wireEntries))
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
        if let index = sessions.firstIndex(where: { $0.id == session.id }) {
            sessions[index] = session
        } else {
            sessions.append(session)
        }
        sessions = sorted(sessions)
        if selectedId == nil { selectedId = session.id }

        guard !settings.hiddenMachines.contains(session.machine) else { return }
        let changed = previous?.status != session.status || previous?.pendingPermissions != session.pendingPermissions
        if session.status.needsAttention && changed { attention.send(session) }
        if previous?.status == .working && session.status == .idle { finished.send(session) }
    }

    private func sorted(_ list: [SessionSummary]) -> [SessionSummary] {
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
    }

    func answer(_ request: PermissionRequest, allow: Bool, in sessionId: String) {
        socket.send(["t": "verdict", "sessionId": sessionId, "requestId": request.requestId, "behavior": allow ? "allow" : "deny"])
    }

    func dismiss(_ sessionId: String) {
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

    func newEnrollment() async throws -> Enrollment {
        guard let account = settings.account else { throw RelayError(message: "No account.") }
        return try await api.newEnrollment(for: account)
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
