import CryptoKit
import Foundation

/// Turns the relay's sealed messages into readable models, and seals what the app sends back.
/// Fields that do not decrypt (another key, corrupted data) degrade to placeholders instead of failing.
public struct SessionVault: Sendable {
    private let key: SymmetricKey

    public init(key: SymmetricKey) {
        self.key = key
    }

    public func session(_ wire: WireSession, machines: [MachineInfo]) -> SessionSummary {
        let info = open(wire.info, as: SessionInfo.self)
        let meta = open(wire.meta, as: SessionMeta.self)
        let permissions = wire.pendingPermissions.compactMap { permission -> PermissionRequest? in
            guard let detail = open(permission.blob, as: PermissionDetail.self) else { return nil }
            return PermissionRequest(
                requestId: permission.requestId, toolName: detail.toolName, description: detail.description,
                inputPreview: detail.inputPreview, ts: permission.ts
            )
        }
        return SessionSummary(
            id: wire.id,
            machineId: wire.machineId,
            machine: info?.machine ?? machines.first { $0.id == wire.machineId }?.name ?? String(core: "Unknown machine"),
            platform: info?.platform,
            cwd: info?.cwd ?? "",
            project: info?.project ?? String(core: "Encrypted session"),
            title: meta?.title,
            status: wire.status,
            statusText: open(wire.statusDetail, as: StatusDetail.self)?.text,
            agentOnline: wire.agentOnline,
            canChat: wire.canChat,
            pendingPermissions: permissions,
            costUSD: meta?.costUSD,
            startedAt: ISO8601.parse(wire.startedAt) ?? .distantPast,
            lastActivity: ISO8601.parse(wire.lastActivity) ?? .distantPast,
            lastMessage: meta?.lastMessage,
            fiveHourLimit: meta?.fiveHourLimit.flatMap(usageLimit),
            sevenDayLimit: meta?.sevenDayLimit.flatMap(usageLimit),
            tokens: meta?.tokens,
            context: meta?.context.map { ContextUsage(usedTokens: $0.usedTokens, windowTokens: $0.windowTokens) },
            terminal: meta?.terminal ?? false,
            // Commands a newer agent knows and this app does not are left out.
            commands: meta?.commands.map { Set($0.compactMap(SessionCommandName.init(rawValue:))) },
            model: meta?.model,
            tool: info?.tool,
            branch: meta?.branch,
            turns: meta?.turns.map { $0.compactMap { turn in ISO8601.parse(turn.end).map { Turn(end: $0, seconds: turn.seconds) } } },
            name: sessionName(wire)
        )
    }

    /// A name sealed for another session is one the relay moved: ignored, like an empty one.
    private func sessionName(_ wire: WireSession) -> String? {
        guard let sealed = open(wire.name, as: SessionName.self), sealed.sessionId == wire.id else { return nil }
        let name = sealed.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? nil : name
    }

    /// Characters of a session name: a few words, well under what the relay keeps.
    public static let maxSessionName = 80

    /// The user's own name for a session, for every Mac of the account. An empty one brings the project back.
    public func sealSessionName(_ name: String, for sessionId: String, issuedAt: Date = Date()) throws -> String {
        let cut = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.maxSessionName))
        let payload = SessionName(
            sessionId: sessionId, name: cut.trimmingCharacters(in: .whitespacesAndNewlines),
            issuedAt: ISO8601DateFormatter().string(from: issuedAt))
        return try E2E.seal(payload, with: key)
    }

    private func usageLimit(_ wire: WireUsageLimit) -> UsageLimit? {
        ISO8601.parse(wire.resetsAt).map { UsageLimit(usedPercent: wire.usedPercent, resetsAt: $0) }
    }

    public func entries(_ wire: [WireEntry]) -> [Entry] {
        wire.compactMap { open($0.blob, as: Entry.self) }
    }

    public func machines(_ wire: [WireMachine]) -> [MachineInfo] {
        wire.map {
            let name = open($0.name, as: MachineName.self)
            return MachineInfo(
                id: $0.id,
                name: name?.name ?? String(core: "Unknown machine"),
                platform: name?.platform,
                createdAt: ISO8601.parse($0.createdAt) ?? .distantPast,
                lastSeen: $0.lastSeen.flatMap(ISO8601.parse),
                online: $0.online,
                agentVersion: $0.agentVersion,
                health: $0.health.flatMap { open($0, as: MachineHealth.self) }
            )
        }
    }

    public func sealPrompt(text: String, images: [OutgoingImage]) throws -> String {
        try E2E.seal(PromptPayload(text: text, images: images), with: key)
    }

    /// A slash command for the session's terminal, sent like a message. Its random id lets the agent run it once.
    public func sealCommand(
        _ name: SessionCommandName, model: ModelFamily? = nil, for sessionId: String, issuedAt: Date = Date()
    ) throws -> String {
        let command = SessionCommand(
            name: name, sessionId: sessionId, id: UUID().uuidString.lowercased(), issuedAt: ISO8601DateFormatter().string(from: issuedAt),
            model: model)
        return try E2E.seal(PromptPayload(text: "", images: [], command: command), with: key)
    }

    /// Agents only obey orders sealed with the account key and issued in the last minutes.
    public func sealUpdateOrder(version: String, issuedAt: Date = Date()) throws -> String {
        try E2E.seal(UpdateOrder(version: version, issuedAt: ISO8601DateFormatter().string(from: issuedAt)), with: key)
    }

    /// Starts claude in a folder of one machine. Like update orders, agents refuse old ones, and run each launch once.
    public func sealStartOrder(
        launchId: String, machineId: String, cwd: String, tool: CodingTool = .claudeCode, issuedAt: Date = Date()
    ) throws -> String {
        let order = StartOrder(
            launchId: launchId, machineId: machineId, cwd: cwd, issuedAt: ISO8601DateFormatter().string(from: issuedAt),
            tool: tool == .openCode ? "opencode" : nil)
        return try E2E.seal(order, with: key)
    }

    /// The user's answer to one question of a start.
    public func sealStartAnswer(
        launchId: String, machineId: String, question: String, confirm: Bool, issuedAt: Date = Date()
    ) throws -> String {
        let answer = StartAnswer(
            launchId: launchId, machineId: machineId, question: question, confirm: confirm,
            issuedAt: ISO8601DateFormatter().string(from: issuedAt))
        return try E2E.seal(answer, with: key)
    }

    public func startDetail(_ blob: String?) -> StartDetail? {
        open(blob, as: StartDetail.self)
    }

    /// Asks a machine for the end of its agent log. It names the machine, and agents refuse old ones.
    public func sealLogRequest(requestId: String, machineId: String, issuedAt: Date = Date()) throws -> String {
        try E2E.seal(
            LogRequest(requestId: requestId, machineId: machineId, issuedAt: ISO8601DateFormatter().string(from: issuedAt)), with: key)
    }

    public func agentLog(_ blob: String?) -> AgentLog? {
        open(blob, as: AgentLog.self)
    }

    /// Asks a machine to check how it is set up, after the repair `fix` names. Like log requests, it names the machine.
    public func sealDiagnoseRequest(requestId: String, machineId: String, fix: String? = nil, issuedAt: Date = Date()) throws -> String {
        let request = DiagnoseRequest(
            requestId: requestId, machineId: machineId, issuedAt: ISO8601DateFormatter().string(from: issuedAt), fix: fix)
        return try E2E.seal(request, with: key)
    }

    public func diagnosis(_ blob: String?) -> Diagnosis? {
        open(blob, as: Diagnosis.self)
    }

    /// A machine's auto-approve rules. Agents keep a set only if it is newer than theirs.
    public func sealRules(_ rules: [PermissionRule], issuedAt: Date) throws -> String {
        try E2E.seal(RuleSet(rules: rules, issuedAt: ISO8601DateFormatter().string(from: issuedAt)), with: key)
    }

    /// The text of a sealed `{ text }` detail, such as the reason an agent update failed.
    public func detailText(_ blob: String?) -> String? {
        open(blob, as: StatusDetail.self)?.text
    }

    /// "Allow for this session": the rules go with the verdict, bound to its session and request.
    public func sealSessionRules(_ rules: [PermissionRule], for sessionId: String, requestId: String) throws -> String {
        try E2E.seal(SessionRules(sessionId: sessionId, requestId: requestId, rules: rules), with: key)
    }

    /// Asks the session's agent to seal a copy of the conversation with the share's key, until the share expires.
    public func sealShareOrder(shareId: String, sessionId: String, shareKey: String, expiresAt: String) throws -> String {
        try E2E.seal(ShareOrder(shareId: shareId, sessionId: sessionId, key: shareKey, expiresAt: expiresAt), with: key)
    }

    public func sealMachineName(_ name: String) throws -> String {
        try E2E.seal(MachineName(name: name, platform: nil), with: key)
    }

    func open<T: Decodable>(_ blob: String?, as type: T.Type) -> T? {
        guard let blob else { return nil }
        return try? E2E.open(blob, as: type, with: key)
    }
}
