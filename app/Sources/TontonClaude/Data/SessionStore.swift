import Combine
import Foundation
import TontonCore
import TontonMac

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
    /// Sessions started from the notch, until they run or the user dismisses why they failed.
    @Published private(set) var launches: [SessionLaunch] = []
    /// A started session to select once the relay lists it.
    private var launchSelection: String?
    /// Machines asked to update that have not answered yet.
    @Published private(set) var updatingMachines: Set<String> = []
    @Published private(set) var updateErrors: [String: String] = [:]
    /// Requests for agent logs, by machine, while their panel is open in Settings › Machines.
    @Published private(set) var agentLogs: [String: AgentLogRequest] = [:]
    /// Requests for diagnoses, by machine, while their panel is open in Settings › Machines.
    @Published private(set) var diagnoses: [String: DiagnosisRequest] = [:]
    /// The repair each machine is running, until its diagnosis comes back.
    @Published private(set) var repairing: [String: String] = [:]
    @Published private var relayEntries: [String: [Entry]] = [:]
    /// Sessions of which only the latest entries came yet: the rest of their history is on its way.
    @Published private var partialHistories: Set<String> = []
    @Published private var localEntries: [String: [Entry]] = [:]
    /// The relay's history once it arrived, this Mac's transcript until then.
    var entries: [String: [Entry]] { LocalSessions.entries(local: localEntries, relay: relayEntries, partial: partialHistories) }
    @Published private(set) var connection: ConnectionState = .notConfigured
    @Published private(set) var latency: RelayLatency?
    @Published var selectedId: String? {
        didSet { if selectedId != oldValue { subscribe() } }
    }
    @Published var lastError: String?

    /// A session started needing the user: permission, question or error.
    let attention = PassthroughSubject<SessionSummary, Never>()
    /// Permission requests that just arrived, for VoiceOver to read out.
    let permissionsAsked = PassthroughSubject<(session: SessionSummary, requests: [PermissionRequest]), Never>()
    /// A session went from working to done.
    let finished = PassthroughSubject<SessionSummary, Never>()
    /// A session finished a task, with how long it worked on it.
    let taskDone = PassthroughSubject<(session: SessionSummary, worked: TimeInterval), Never>()
    /// When the 5-hour windows run out at the current pace. Not published: the rows read it with their countdown.
    private(set) var forecast = LimitForecast()
    private var workTimer = WorkTimer()
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
    /// Claude Code asks a question while a session started from the notch starts.
    let launchAsks = PassthroughSubject<SessionLaunch, Never>()
    /// A session started from the notch runs.
    let launchStarted = PassthroughSubject<SessionLaunch, Never>()

    private let settings: AppSettings
    private let socket = RelaySocket()
    private let api = RelayAPI()
    private var vault: SessionVault?
    private let localWatcher = LocalSessionWatcher()
    /// This Mac's OpenCode 2 sessions, from OpenCode's own service. The notch can write to them without the agent.
    private let openCodeWatcher = OpenCodeLocalWatcher()
    private var claudeHere: (sessions: [SessionSummary], entries: [String: [Entry]]) = ([], [:])
    private var openCodeHere: (sessions: [SessionSummary], entries: [String: [Entry]]) = ([], [:])
    /// Finished conversations kept on this Mac (Settings › Archive).
    let archive = ArchiveStore()
    /// Relay sessions that ended while not followed: archived once their whole history has come.
    private var archiveOnHistory: Set<String> = []
    /// Cost and tokens per day and the monthly recap, for Settings › Usage.
    private(set) lazy var usage = UsageRecorder(
        sessions: sessionsPublisher, tasks: taskDone.eraseToAnyPublisher(), entries: entriesPublisher, settings: settings)
    /// The conversations of this Mac and of the relay, merged as `entries` merges them.
    var entriesPublisher: AnyPublisher<[String: [Entry]], Never> {
        $localEntries.combineLatest($relayEntries, $partialHistories).map { local, relay, partial in
            LocalSessions.entries(local: local, relay: relay, partial: partial)
        }
        .eraseToAnyPublisher()
    }
    /// One per reset time of the sessions a usage limit stopped.
    private var resetTimers: [Date: Task<Void, Never>] = [:]
    private var subscriptions = Set<AnyCancellable>()
    /// Histories fetched for the search and the archive, one session after the other.
    private var catchUp = HistoryCatchUp()
    /// The socket those histories come through, open while a catch-up runs: the main one never leaves the selected
    /// session, whose live entries would wait otherwise.
    private let fetchSocket = RelaySocket()
    /// Machines that got the current auto-approve rules since the app connected.
    private var rulesSentTo: Set<String> = []

    init(settings: AppSettings) {
        self.settings = settings
        socket.onState = { [weak self] state in self?.socketStateChanged(state) }
        socket.onMessage = { [weak self] message in self?.handle(message) }
        socket.onLatency = { [weak self] latency in self?.latency = latency }
        fetchSocket.onMessage = { [weak self] message in self?.fetched(message) }
        fetchSocket.onState = { [weak self] state in if state == .connected { self?.fetch(self?.catchUp.waitingFor) } }
        // The join secret does not change the connection.
        // Each account has its archive. `$account` sends the new account before `settings.account` holds it.
        settings.$account.removeDuplicates { $0.map(AccountList.id(of:)) == $1.map(AccountList.id(of:)) }
            .sink { [weak self] account in self?.archive.use(account: account) }
            .store(in: &subscriptions)
        settings.$account.map { $0.map { [$0.relay, $0.token, $0.key] } }.removeDuplicates()
            .combineLatest(settings.$connectionEnabled)
            .dropFirst()
            .debounce(for: .milliseconds(300), scheduler: RunLoop.main)
            .sink { [weak self] _ in self?.connect() }
            .store(in: &subscriptions)
        localWatcher.onChange = { [weak self] sessions, entries in
            self?.claudeHere = (sessions, entries)
            self?.localChanged()
        }
        localWatcher.start()
        openCodeWatcher.onChange = { [weak self] sessions, entries in
            self?.openCodeHere = (sessions, entries)
            self?.localChanged()
        }
        openCodeWatcher.start()
        // A new set goes to every machine, and replaces the one the relay keeps for each.
        settings.$autoApproveRulesDate.dropFirst().removeDuplicates()
            .sink { [weak self] _ in
                self?.rulesSentTo = []
                Task { @MainActor in self?.sendRules() }
            }
            .store(in: &subscriptions)
        sessionsPublisher.combineLatest(settings.$hiddenMachines)
            .sink { [weak self] sessions, hidden in self?.scheduleLimitResets(sessions.filter { !hidden.contains($0.machine) }) }
            .store(in: &subscriptions)
        sessionsPublisher
            .sink { [weak self] sessions in self?.forecast.record(sessions.filter(\.status.isLive).map(\.fiveHourLimit)) }
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
        let now = Date()
        return sessions.filter { session in
            !settings.hiddenMachines.contains(session.machine)
                && FinishedSessions.isShown(session, hideAfterHours: settings.hideFinishedAfterHours, now: now)
        }
    }

    /// Finished sessions the setting keeps out of the list, for the eye button.
    var hiddenFinishedCount: Int {
        sessions.filter { !settings.hiddenMachines.contains($0.machine) && !$0.status.isLive }.count
            - visibleSessions.filter { !$0.status.isLive }.count
    }

    /// Sessions of the shown machines, finished ones included: the list header stays while all are hidden.
    var hasSessions: Bool { sessions.contains { !settings.hiddenMachines.contains($0.machine) } }

    /// The machine id of the agent on this Mac, read again from its config whenever the machines change.
    @Published private(set) var thisMac: String?

    func isOnThisMac(_ session: SessionSummary) -> Bool { thisMachines.contains(session.machineId) }

    /// A session the relay reports, whose history it keeps.
    func isRelaySession(_ sessionId: String) -> Bool { relaySessions.contains { $0.id == sessionId } }

    /// This Mac's sessions, whether they come from its agent or straight from its files.
    var thisMachines: Set<String> { Set([LocalSessions.machineId] + [thisMac].compactMap { $0 }) }

    /// The list as the notch shows it, pinned sessions first, then this Mac's.
    var sections: [SessionSection] {
        SessionLayout.sections(visibleSessions, pinned: settings.pinnedSessions, thisMac: thisMachines, tags: settings.projectTags)
    }
    var orderedSessions: [SessionSummary] {
        SessionLayout.ordered(visibleSessions, pinned: settings.pinnedSessions, thisMac: thisMachines, tags: settings.projectTags)
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
        shares = []
        machines = []
        thisMac = nil
        relayEntries = [:]
        partialHistories = []
        catchUp.cancel()
        fetchSocket.disconnect()
        updatingMachines = []
        updateErrors = [:]
        launches = []
        launchSelection = nil
        agentLogs = [:]
        diagnoses = [:]
        repairing = [:]
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
        if state != .connected {
            catchUp.cancel()
            fetchSocket.disconnect()
        }
        if state == .connected {
            subscribe()
            // Histories asked for the archive before the connection dropped: asked again.
            for sessionId in archiveOnHistory {
                if let first = catchUp.fetch(sessionId, selected: selectedId) { fetch(first) }
            }
        }
    }

    private func handle(_ message: RelayMessage) {
        guard let vault else { return }
        switch message {
        case .snapshot(let wireSessions, let wireMachines):
            machines = vault.machines(wireMachines)
            rulesSentTo = []
            sendRules()
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
            sendRules()
            thisMac = settings.account.flatMap { LocalAgent.machineId(for: $0.accountId) }
        case .removed(let sessionId):
            relaySessions.removeAll { $0.id == sessionId }
            relayEntries[sessionId] = nil
            partialHistories.remove(sessionId)
            settings.pinnedSessions.removeAll { $0 == sessionId }
            if selectedId == sessionId { selectedId = preferredSelection() }
        case .history(let sessionId, let wireEntries):
            relayEntries[sessionId] = vault.entries(wireEntries)
            partialHistories.remove(sessionId)
            if archiveOnHistory.remove(sessionId) != nil, let session = relaySessions.first(where: { $0.id == sessionId }) {
                archive.add(session, entries: entries[sessionId] ?? [])
            }
        case .recentHistory(let sessionId, let wireEntries):
            guard ConversationLoad.takesRecent(current: relayEntries[sessionId], partial: partialHistories.contains(sessionId))
            else { return }
            relayEntries[sessionId] = vault.entries(wireEntries)
            partialHistories.insert(sessionId)
        case .entries(let sessionId, let wireEntries):
            relayEntries[sessionId, default: []].append(contentsOf: vault.entries(wireEntries))
        case .error(let text):
            lastError = text
        case .agentUpdate(let machineId, let ok, let reason, let detail):
            updateFinished(machineId, ok: ok, reason: reason, detail: vault.detailText(detail))
        case .sessionStart(let machineId, let launchId, let state, let reason, let detail):
            launchReported(launchId, machineId: machineId, state: state, reason: reason, detail: vault.startDetail(detail))
        case .agentLogs(let machineId, let requestId, let reason, let logs):
            logReceived(machineId: machineId, requestId: requestId, reason: reason, log: vault.agentLog(logs))
        case .diagnosis(let machineId, let requestId, let reason, let diagnosis):
            diagnosisReceived(machineId: machineId, requestId: requestId, reason: reason, diagnosis: vault.diagnosis(diagnosis))
        case .unknown:
            break
        }
    }

    private func update(_ session: SessionSummary) {
        let previous = sessions.first { $0.id == session.id }
        if let pending = pendingNames[session.id], pending == session.name { pendingNames[session.id] = nil }
        if let index = relaySessions.firstIndex(where: { $0.id == session.id }) {
            relaySessions[index] = session
        } else {
            relaySessions.append(session)
        }
        if selectedId == nil || session.id == launchSelection {
            selectedId = session.id
            launchSelection = nil
        }
        notify(session, previous: previous)
    }

    private func localChanged() {
        let sessions = claudeHere.sessions + openCodeHere.sessions
        let entries = claudeHere.entries.merging(openCodeHere.entries) { claude, _ in claude }
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
        // Hidden machines have no alerts, but their conversations still go to the archive.
        if session.status == .ended && previous != nil && previous?.status != .ended && settings.archiveFinished {
            archiveConversation(session)
        }
        guard !settings.hiddenMachines.contains(session.machine) else { return }
        let changed = previous?.status != session.status || previous?.pendingPermissions != session.pendingPermissions
        if session.status.needsAttention && changed { attention.send(session) }
        let asked = PermissionRequest.added(session.pendingPermissions, since: previous?.pendingPermissions ?? [])
        if !asked.isEmpty { permissionsAsked.send((session, asked)) }
        if previous?.status == .working && session.status == .idle { finished.send(session) }
        if let worked = workTimer.update(session, previous: previous?.status) { taskDone.send((session, worked)) }
    }

    /// Keeps the session's conversation in Settings › Archive. The app only follows the selected relay session: the
    /// history of another one is fetched first, so the whole conversation is kept, not what was seen of it.
    func archiveConversation(_ session: SessionSummary) {
        let followed = session.id == selectedId || !relaySessions.contains { $0.id == session.id }
        guard !followed, connection == .connected else { return archive.add(session, entries: entries[session.id] ?? []) }
        archiveOnHistory.insert(session.id)
        if let first = catchUp.fetch(session.id, selected: selectedId) { fetch(first) }
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

    /// Relays that know `latestFirst` send the end of the conversation at once, then all of it.
    private func subscribe() {
        guard connection == .connected else { return }
        socket.send(["t": "subscribe", "sessionId": selectedId ?? NSNull(), "latestFirst": true])
    }

    /// The next session of a catch-up, on the fetch socket, or closes it when the catch-up is done.
    private func fetch(_ sessionId: String?) {
        guard let sessionId else { return fetchSocket.disconnect() }
        guard connection == .connected, let account = settings.account else {
            catchUp.cancel()
            return fetchSocket.disconnect()
        }
        switch fetchSocket.state {
        case .connected: fetchSocket.send(["t": "subscribe", "sessionId": sessionId])
        // Once connected, its `onState` asks for the session the catch-up waits for.
        case .connecting: break
        default: fetchSocket.connect(account)
        }
    }

    /// Only the histories a catch-up asked for count on the fetch socket; the rest comes on the main one too.
    private func fetched(_ message: RelayMessage) {
        guard case .history(let sessionId, let wireEntries) = message, sessionId == catchUp.waitingFor, let vault else { return }
        // The selected session is kept current by the main socket: an older copy must not replace it.
        if sessionId != selectedId {
            relayEntries[sessionId] = vault.entries(wireEntries)
            partialHistories.remove(sessionId)
        }
        if archiveOnHistory.remove(sessionId) != nil, let session = relaySessions.first(where: { $0.id == sessionId }) {
            archive.add(session, entries: entries[sessionId] ?? [])
        }
        fetch(catchUp.received(sessionId))
    }

    /// Whether the conversation of a session is still on its way, for the chat to say so.
    func load(of sessionId: String) -> ConversationLoad {
        ConversationLoad.state(
            relaySession: isRelaySession(sessionId), reachable: connection == .connected || connection == .connecting,
            relayEntries: relayEntries[sessionId], partial: partialHistories.contains(sessionId),
            localEntries: localEntries[sessionId]?.count ?? 0)
    }

    /// Fetches the conversations of the relay sessions never opened, so the search finds their messages.
    func catchUpHistories() {
        guard connection == .connected else { return }
        let missing = relaySessions.map(\.id).filter { relayEntries[$0] == nil }
        if let first = catchUp.start(sessions: missing, selected: selectedId) { fetch(first) }
    }

    /// An OpenCode session of this Mac that no agent reports: the notch talks to OpenCode's service itself.
    private func isOpenCodeHere(_ sessionId: String) -> Bool {
        !relaySessions.contains { $0.id == sessionId } && openCodeHere.sessions.contains { $0.id == sessionId }
    }

    func sendPrompt(_ text: String, images: [OutgoingImage], to sessionId: String) {
        if isOpenCodeHere(sessionId) {
            openCodeWatcher.prompt(text, images: images, to: sessionId)
            sent.send()
            return
        }
        guard let payload = try? vault?.sealPrompt(text: text, images: images) else { return }
        socket.send(["t": "prompt", "sessionId": sessionId, "payload": payload])
        sent.send()
    }

    /// Typed in the session's terminal by its agent. What it says back, if it could not, shows in the conversation.
    func sendCommand(_ name: SessionCommandName, model: ModelFamily? = nil, to sessionId: String) {
        if isOpenCodeHere(sessionId) {
            if name == .compact { openCodeWatcher.compact(sessionId) }
            return
        }
        guard let payload = try? vault?.sealCommand(name, model: model, for: sessionId) else { return }
        socket.send(["t": "prompt", "sessionId": sessionId, "payload": payload])
    }

    func answer(_ request: PermissionRequest, allow: Bool, in sessionId: String) {
        if isOpenCodeHere(sessionId) {
            openCodeWatcher.answer(request.requestId, allow: allow, in: sessionId)
            if allow { approved.send() }
            return
        }
        socket.send(["t": "verdict", "sessionId": sessionId, "requestId": request.requestId, "behavior": allow ? "allow" : "deny"])
        if allow { approved.send() }
    }

    /// What "Allow for this session" offers, for sessions an agent serves: it keeps the rules until the session ends.
    func sessionRule(for request: PermissionRequest, in session: SessionSummary) -> SessionRule? {
        guard relaySessions.contains(where: { $0.id == session.id }), !isOpenCodeHere(session.id),
            machines.first(where: { $0.id == session.machineId })?.keepsSessionRules == true
        else { return nil }
        return SessionRule.suggested(tool: request.toolName, inputPreview: request.inputPreview)
    }

    func allowForSession(_ request: PermissionRequest, rule: SessionRule, in sessionId: String) {
        guard let sealed = try? vault?.sealSessionRules(rule.rules, for: sessionId, requestId: request.requestId) else { return }
        socket.send(["t": "verdict", "sessionId": sessionId, "requestId": request.requestId, "behavior": "allow", "rule": sealed])
        approved.send()
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

    // MARK: Names

    /// Names sent to the relay that have not come back with their session yet.
    private var pendingNames: [String: String?] = [:]

    /// Sessions the relay keeps: it holds the name for the other Macs. This Mac's sessions without an agent aren't there.
    func canRename(_ session: SessionSummary) -> Bool {
        connection == .connected && relaySessions.contains { $0.id == session.id }
    }

    /// Names the session on every Mac of the account, sealed like the rest. An empty name brings the project back.
    func rename(_ session: SessionSummary, to name: String) {
        let cut = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(SessionVault.maxSessionName))
        let trimmed = cut.trimmingCharacters(in: .whitespacesAndNewlines)
        let wanted: String? = trimmed.isEmpty || trimmed == session.project ? nil : trimmed
        guard canRename(session), wanted != session.name, let sealed = try? vault?.sealSessionName(wanted ?? "", for: session.id) else {
            return
        }
        pendingNames[session.id] = wanted
        socket.send(["t": "rename", "sessionId": session.id, "name": sealed])
        // A relay too old to keep names never sends the session back with it.
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            guard let self, let pending = self.pendingNames[session.id], pending == wanted else { return }
            self.pendingNames[session.id] = nil
            self.lastError = "The relay did not keep the name. It may be too old to rename sessions."
        }
    }

    // MARK: Auto-approve rules

    /// Seals each machine's rules and sends them to the ones that don't have them yet. The relay passes them on to the
    /// machine now and on each of its next connections; an empty set clears rules removed in the app.
    private func sendRules() {
        guard connection == .connected, let vault else { return }
        for machine in machines where !rulesSentTo.contains(machine.id) {
            let rules = AutoApproveRule.rules(settings.autoApproveRules, for: machine.id)
            guard let sealed = try? vault.sealRules(rules, issuedAt: settings.autoApproveRulesDate) else { continue }
            socket.send(["t": "rules", "machineId": machine.id, "rules": sealed])
            rulesSentTo.insert(machine.id)
        }
    }

    // MARK: Starting sessions

    /// Folders to offer for a new session on the machine.
    func recentFolders(on machineId: String) -> [String] {
        RecentFolders.list(started: settings.startFolders[machineId] ?? [], sessions: sessions, machineId: machineId)
    }

    /// Asks the machine's agent to start claude in the folder. Its answers come back as `session_start` messages.
    func startSession(on machine: MachineInfo, in folder: String, tool: CodingTool = .claudeCode) {
        let folder = RecentFolders.normalized(folder)
        // Only agents that list OpenCode know how to start it: an older one would start claude instead.
        guard connection == .connected, RecentFolders.isStartable(folder), machine.startableTools.contains(tool) else { return }
        let launch = SessionLaunch(machineId: machine.id, cwd: folder, tool: tool)
        guard let order = try? vault?.sealStartOrder(launchId: launch.id, machineId: machine.id, cwd: folder, tool: tool) else { return }
        launches.append(launch)
        settings.startFolders[machine.id] = RecentFolders.adding(folder, to: settings.startFolders[machine.id] ?? [])
        socket.send(["t": "start_session", "machineId": machine.id, "launchId": launch.id, "order": order])
        // An agent too old to start sessions never answers.
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(20))
            guard let self, let current = self.launches.first(where: { $0.id == launch.id }), current.state == .sending else { return }
            self.replace(current.failed("No answer from \(machine.name). Its agent may be too old to start sessions: update it."))
        }
    }

    /// The user's answer to the question a start is waiting on.
    func answerStart(_ launch: SessionLaunch, confirm: Bool) {
        guard launch.state == .asking, let question = launch.questionId,
            let answer = try? vault?.sealStartAnswer(launchId: launch.id, machineId: launch.machineId, question: question, confirm: confirm)
        else { return }
        socket.send(["t": "start_answer", "machineId": launch.machineId, "launchId": launch.id, "answer": answer])
        replace(launch.answered(question))
    }

    func dismissLaunch(_ id: String) {
        launches.removeAll { $0.id == id }
    }

    private func launchReported(_ id: String, machineId: String, state: String, reason: String?, detail: StartDetail?) {
        guard let launch = launches.first(where: { $0.id == id && $0.machineId == machineId }) else { return }
        let name = machines.first { $0.id == machineId }?.name ?? "The machine"
        let next = launch.reported(state, reason: reason, detail: detail, machine: name)
        guard next != launch else { return }
        if next.state == .started {
            launches.removeAll { $0.id == id }
            if let sessionId = next.sessionId {
                if sessions.contains(where: { $0.id == sessionId }) { selectedId = sessionId } else { launchSelection = sessionId }
            }
            launchStarted.send(next)
            return
        }
        replace(next)
        if next.state == .asking { launchAsks.send(next) }
    }

    private func replace(_ launch: SessionLaunch) {
        launches = launches.map { $0.id == launch.id ? launch : $0 }
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

    // MARK: Read-only shares

    /// The account's shares still running, as the relay last listed them.
    @Published private(set) var shares: [ShareSummary] = []

    /// Only sessions an agent sends to the relay: the share's copy is sealed by that agent.
    func canShare(_ session: SessionSummary) -> Bool {
        connection == .connected && relaySessions.contains { $0.id == session.id }
    }

    /// Makes a share of the session and asks its agent to seal a copy for it. Returns what the teammate pastes.
    func share(_ session: SessionSummary, for duration: ShareDuration) async throws -> ShareLink {
        guard let account = settings.account, let vault, connection == .connected else {
            throw RelayError(message: "Connect to the relay to share a session.")
        }
        if let machine = machines.first(where: { $0.id == session.machineId }), !machine.sealsShares {
            throw RelayError(message: "The agent on \(machine.name) is too old to share a session. Update agent first.")
        }
        let created: (id: String, token: String, expiresAt: String)
        do {
            created = try await api.createShare(of: session.id, hours: duration.hours, for: account)
        } catch let error as RelayError where error.message == "not found" {
            throw RelayError(message: "This relay is too old to share sessions: it needs 0.8.0 or later.")
        }
        let key = E2E.newKey()
        let order = try vault.sealShareOrder(shareId: created.id, sessionId: session.id, shareKey: key, expiresAt: created.expiresAt)
        socket.send(["t": "share", "sessionId": session.id, "shareId": created.id, "order": order])
        await refreshShares()
        return ShareLink(relay: account.relay, token: created.token, key: key)
    }

    func refreshShares() async {
        guard let account = settings.account else { return }
        // Another account may be connected by the time the relay answers.
        if let listed = try? await api.shares(of: account), isConnected(account) { shares = listed }
    }

    /// Closes the teammates' pages at once, and the agent stops sealing for it.
    func revokeShare(_ id: String) async throws {
        guard let account = settings.account else { return }
        try await api.revokeShare(id, of: account)
        shares.removeAll { $0.id == id }
    }

    // MARK: Agent logs

    /// Asks the machine for the end of its agent log, sealed on the way back. A new request replaces the previous one.
    func requestLog(of machine: MachineInfo) {
        let request = AgentLogRequest(machineId: machine.id, previous: agentLogs[machine.id]?.answer)
        guard connection == .connected, let sealed = try? vault?.sealLogRequest(requestId: request.id, machineId: machine.id) else {
            agentLogs[machine.id] = request.failed("Not connected to the relay.")
            return
        }
        agentLogs[machine.id] = request
        socket.send(["t": "agent_logs", "machineId": machine.id, "requestId": request.id, "request": sealed])
        // An agent or a relay too old to send logs never answers.
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard let self, let current = self.agentLogs[machine.id], current.id == request.id, current.isLoading else { return }
            self.agentLogs[machine.id] = current.failed(
                "No answer from \(machine.name). Its agent may be too old to send its log: update it.")
        }
    }

    func closeLog(of machineId: String) {
        agentLogs[machineId] = nil
    }

    private func logReceived(machineId: String, requestId: String, reason: String?, log: AgentLog?) {
        guard let request = agentLogs[machineId], request.id == requestId else { return }
        let name = machines.first { $0.id == machineId }?.name ?? "The machine"
        agentLogs[machineId] = request.received(reason: reason, answer: log, machine: name)
    }

    // MARK: Diagnosis

    /// Asks the machine's agent to check how the machine is set up, after the repair `fix` names if any.
    func diagnose(_ machine: MachineInfo, fix: String? = nil) {
        let request = DiagnosisRequest(machineId: machine.id, previous: diagnoses[machine.id]?.answer)
        guard connection == .connected,
            let sealed = try? vault?.sealDiagnoseRequest(requestId: request.id, machineId: machine.id, fix: fix)
        else {
            diagnoses[machine.id] = request.failed("Not connected to the relay.")
            return
        }
        diagnoses[machine.id] = request
        repairing[machine.id] = fix
        socket.send(["t": "diagnose", "machineId": machine.id, "requestId": request.id, "request": sealed])
        // An agent or a relay too old to diagnose never answers. Starting the service can take a few seconds.
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(25))
            guard let self, let current = self.diagnoses[machine.id], current.id == request.id, current.isLoading else { return }
            self.diagnoses[machine.id] = current.failed(
                "No answer from \(machine.name). Its agent may be too old to check itself: update it.")
            self.repairing[machine.id] = nil
        }
    }

    func closeDiagnosis(of machineId: String) {
        diagnoses[machineId] = nil
    }

    private func diagnosisReceived(machineId: String, requestId: String, reason: String?, diagnosis: Diagnosis?) {
        guard let request = diagnoses[machineId], request.id == requestId else { return }
        let name = machines.first { $0.id == machineId }?.name ?? "The machine"
        let next = request.received(reason: reason, answer: diagnosis, machine: name)
        diagnoses[machineId] = next
        if !next.isLoading { repairing[machineId] = nil }
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
        updated(account.with(joinSecret: try await api.joinSecret(for: account, regenerate: false)))
    }

    /// A new token and a new encryption key: every machine is signed out until it gets the new token, and other Macs
    /// signed in to the account need the new recovery key.
    func regenerateMachineToken() async throws {
        guard let account = settings.account else { return }
        let secret = try await api.joinSecret(for: account, regenerate: true)
        updated(account.with(key: E2E.newKey(), joinSecret: secret))
    }

    /// New keys for an account after a request to the relay: it may not be the connected one any more, but its saved copy
    /// must get them.
    private func updated(_ account: Account) {
        if isConnected(account) { settings.account = account } else { settings.accounts.save(account) }
    }

    private func isConnected(_ account: Account) -> Bool {
        settings.account.map(AccountList.id(of:)) == AccountList.id(of: account)
    }

    func revoke(_ machine: MachineInfo) async throws {
        guard let account = settings.account else { return }
        try await api.revokeMachine(machine.id, of: account)
    }

    func deleteAccount() async throws {
        guard let account = settings.account else { return }
        try await api.deleteAccount(account)
        archive.forget(account)
        // The one deleted, even if the user switched to another meanwhile.
        signOut(of: account)
    }

    /// Signs this Mac out of an account, the connected one by default: it leaves the list, with its keys. The others stay,
    /// to switch to.
    func signOut(of account: Account? = nil) {
        guard let account = account ?? settings.account else { return }
        settings.accounts.remove(account)
        settings.parkedPins[AccountList.id(of: account)] = nil
        if isConnected(account) { settings.account = nil }
    }

    /// Connects to another account signed in on this Mac. The one connected now stays in the list, and its pins wait for
    /// it: the sessions of the next account would not include them, and they would be dropped.
    func switchAccount(to account: Account) {
        guard settings.accounts.entry(for: account) != nil, !isConnected(account) else { return }
        let here = Set(localSessions.map(\.id))
        if let current = settings.account {
            settings.parkedPins[AccountList.id(of: current)] = settings.pinnedSessions.filter { !here.contains($0) }
        }
        let parked = settings.parkedPins.removeValue(forKey: AccountList.id(of: account)) ?? []
        settings.pinnedSessions = settings.pinnedSessions.filter { here.contains($0) } + parked
        selectedId = nil
        settings.account = account
    }
}
