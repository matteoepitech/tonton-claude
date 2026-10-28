import Foundation

// A pool as the app reads it (docs/pools.md): its snapshot and every change after it, opened with the pool key and
// folded into one value, like shared/pool.ts. What another member sealed reads as nil when it does not open or does not
// have the expected shape. `PoolBoard` keeps it with the keys the member holds, and opens newer versions of the pool key
// as admins rotate it.

/// How many messages and events the app keeps in memory per pool, as the web does.
let keptPoolPosts = 500

public struct PoolState: Equatable, Sendable {
    public struct Member: Equatable, Sendable {
        public let account: String
        public let role: PoolRole
        public let joinedAt: String
        public let profile: PoolMemberProfile?
        /// Its public key, sealed with each version it was published under: what an admin wraps a new key for.
        let publicKeys: [String]
    }

    public struct Session: Equatable, Sendable {
        public let account: String
        public let session: String
        public let joinedAt: String
        public let profile: PoolSessionProfile?
        /// Its agent is connected.
        public let online: Bool
        /// Its agent took the order and holds the pool key.
        public let ready: Bool
    }

    public struct Task: Equatable, Sendable, Identifiable {
        public let id: String
        public let rev: Int
        public let updatedAt: String
        /// Who changed it last.
        public let account: String
        public let session: String?
        /// Nil when it does not open with the pool key.
        public let task: PoolTask?
    }

    public struct Post<Body: Equatable & Sendable>: Equatable, Sendable, Identifiable {
        public let id: String
        public let seq: Int
        public let ts: String
        public let account: String
        public let session: String?
        public let body: Body?
    }

    public let id: String
    public var paused: Bool
    public var keyVersion: Int
    public var info: PoolInfo?
    public var members: [Member]
    public var sessions: [Session]
    public var tasks: [Task]
    public var notes: String?
    /// The areas of the notes, with the paths each owns: a hackathon's roles.
    public var areas: [PoolArea] = []
    public var messages: [Post<PoolMessageBody>]
    public var events: [Post<PoolEventBody>]
    /// The session owners and admins chose to plan and hand out the work; nil: none yet.
    public var orchestrator: PoolSessionRef?
    /// The auto-approve rules proposed to the sessions, and the budgets, as last set. Nil: none, or an older relay.
    public var rules: PoolRules?
    public var budgets: PoolBudgets?
    /// The latest lines of what the relay enforced, oldest first.
    public var audit: [PoolAuditWire]
    /// This member's private key for the pool and the pool keys wrapped for it.
    var own: PoolOwnKeys

    public init(snapshot: PoolSnapshot, vault: PoolVault) {
        id = snapshot.id
        paused = snapshot.paused
        keyVersion = snapshot.keyVersion
        info = vault.open(snapshot.info, as: PoolInfo.self)
        members = snapshot.members.map { Self.member($0, vault) }
        sessions = snapshot.sessions.map { Self.session($0, vault) }
        tasks = snapshot.tasks.compactMap { Self.task($0, vault) }
        let opened = snapshot.notes.flatMap { vault.open($0.blob, as: PoolNotes.self) }
        notes = opened?.text
        areas = opened?.areas ?? []
        messages = snapshot.messages.compactMap { Self.post($0, vault) }
        events = snapshot.events.compactMap { Self.post($0, vault) }
        own = snapshot.own ?? PoolOwnKeys(secret: nil, wraps: [])
        orchestrator = snapshot.orchestrator
        rules = snapshot.rules.flatMap { vault.open($0.blob, as: PoolRules.self) }
        budgets = snapshot.budgets.flatMap { vault.open($0.blob, as: PoolBudgets.self) }
        audit = Array((snapshot.audit ?? []).suffix(keptPoolPosts))
    }

    /// Folds a change in. False when the pool is gone for this member.
    public mutating func apply(_ update: PoolUpdate, vault: PoolVault) -> Bool {
        switch update {
        case .snapshot(let snapshot):
            if snapshot.id == id { self = PoolState(snapshot: snapshot, vault: vault) }
        case .task(_, let wire):
            guard let item = Self.task(wire, vault) else { break }
            if let index = tasks.firstIndex(where: { $0.id == item.id }) { tasks[index] = item } else { tasks.append(item) }
        case .notes(_, let wire):
            let opened = vault.open(wire.blob, as: PoolNotes.self)
            notes = opened?.text
            areas = opened?.areas ?? []
        case .message(_, let wire):
            if let post: Post<PoolMessageBody> = Self.post(wire, vault) { messages = Array((messages + [post]).suffix(keptPoolPosts)) }
        case .event(_, let wire):
            if let post: Post<PoolEventBody> = Self.post(wire, vault) { events = Array((events + [post]).suffix(keptPoolPosts)) }
        case .info(_, let sealed, let paused, let keyVersion):
            (info, self.paused, self.keyVersion) = (vault.open(sealed, as: PoolInfo.self), paused, keyVersion)
        case .member(_, let wire):
            members = members.filter { $0.account != wire.account } + [Self.member(wire, vault)]
        case .memberLeft(_, let account):
            members.removeAll { $0.account == account }
            sessions.removeAll { $0.account == account }
        case .session(_, let wire):
            sessions = sessions.filter { $0.account != wire.account || $0.session != wire.session } + [Self.session(wire, vault)]
        case .sessionLeft(_, let account, let session):
            sessions.removeAll { $0.account == account && $0.session == session }
        case .key(_, let wrap):
            own = PoolOwnKeys(
                secret: own.secret, wraps: (own.wraps.filter { $0.version != wrap.version } + [wrap]).sorted { $0.version < $1.version })
        case .orchestrator(_, let ref):
            orchestrator = ref
        case .rules(_, let wire):
            rules = vault.open(wire.blob, as: PoolRules.self)
        case .budgets(_, let wire):
            budgets = vault.open(wire.blob, as: PoolBudgets.self)
        case .audit(_, let entry):
            audit = Array((audit + [entry]).suffix(keptPoolPosts))
        case .removed:
            return false
        case .conflict, .error:
            break
        }
        return true
    }

    /// The pool the update is about.
    public static func poolId(of update: PoolUpdate) -> String {
        switch update {
        case .snapshot(let snapshot): snapshot.id
        case .task(let id, _), .notes(let id, _), .message(let id, _), .event(let id, _), .info(let id, _, _, _), .member(let id, _),
            .memberLeft(let id, _), .session(let id, _), .sessionLeft(let id, _, _), .key(let id, _), .conflict(let id, _, _, _),
            .removed(let id), .error(let id, _), .orchestrator(let id, _), .rules(let id, _), .budgets(let id, _), .audit(let id, _):
            id
        }
    }

    // MARK: Reading

    public func session(_ sessionId: String) -> Session? { sessions.first { $0.session == sessionId } }

    public func memberName(_ account: String) -> String {
        members.first { $0.account == account }?.profile?.name ?? String(core: "A member")
    }

    /// `Ana · back`, `Ana · orchestrator`, or `Ana` for an app or the website, as the agent names them.
    public func who(account: String, session: String?) -> String {
        let profile = session.flatMap { id in sessions.first { $0.account == account && $0.session == id } }?.profile
        let leads = session != nil && orchestrator?.account == account && orchestrator?.session == session
        let role = leads ? String(core: "orchestrator") : profile?.area
        return role.map { "\(memberName(account)) · \($0)" } ?? memberName(account)
    }

    /// What the session works on: the task assigned to it that is furthest along, not done.
    public func currentTask(of sessionId: String) -> Task? {
        let order: [PoolTaskState] = [.inProgress, .review, .blocked, .assigned]
        return
            tasks
            .filter { $0.task?.assignee?.session == sessionId && order.contains($0.task?.state ?? .done) }
            .min { order.firstIndex(of: $0.task?.state ?? .done) ?? 9 < order.firstIndex(of: $1.task?.state ?? .done) ?? 9 }
    }

    /// Tasks given to the session that it has not started: its owner accepts or refuses them from the notch.
    public func waitingTasks(of sessionId: String) -> [Task] {
        tasks.filter { $0.task?.assignee?.session == sessionId && $0.task?.state == .assigned }
    }

    /// The latest messages the session sent or got: to it, to its area or to everyone.
    public func messages(of sessionId: String, limit: Int = 20) -> [Post<PoolMessageBody>] {
        let area = session(sessionId)?.profile?.area
        let shown = messages.filter { post in
            guard let body = post.body else { return false }
            if post.session == sessionId { return true }
            guard let to = body.to else { return true }
            if let target = to.session { return target.session == sessionId }
            return to.area != nil && to.area == area
        }
        return Array(shown.suffix(limit))
    }

    /// The task put back on the board for someone else, as the session's owner refused it.
    public static func refused(_ task: PoolTask) -> PoolTask {
        var next = task
        next.state = .todo
        next.assignee = nil
        return next
    }

    // MARK: Opening

    private static func member(_ wire: PoolMemberWire, _ vault: PoolVault) -> Member {
        Member(
            account: wire.account, role: wire.role, joinedAt: wire.joinedAt, profile: vault.open(wire.profile, as: PoolMemberProfile.self),
            publicKeys: wire.publicKeys)
    }

    private static func session(_ wire: PoolSessionWire, _ vault: PoolVault) -> Session {
        Session(
            account: wire.account, session: wire.session, joinedAt: wire.joinedAt,
            profile: vault.open(wire.profile, as: PoolSessionProfile.self), online: wire.online, ready: wire.ready)
    }

    private static func task(_ wire: PoolItemWire, _ vault: PoolVault) -> Task? {
        guard let id = wire.id else { return nil }
        return Task(
            id: id, rev: wire.rev ?? 0, updatedAt: wire.updatedAt ?? "", account: wire.account, session: wire.session,
            task: vault.open(wire.blob, as: PoolTask.self))
    }

    private static func post<Body: Decodable>(_ wire: PoolItemWire, _ vault: PoolVault) -> Post<Body>? {
        guard let id = wire.id else { return nil }
        return Post(
            id: id, seq: wire.seq ?? 0, ts: wire.ts ?? "", account: wire.account, session: wire.session,
            body: vault.open(wire.blob, as: Body.self))
    }

    /// As the relay listed them, for opening newer versions of the pool key.
    var memberWires: [PoolMemberWire] {
        members.map { PoolMemberWire(account: $0.account, role: $0.role, joinedAt: $0.joinedAt, profile: nil, publicKeys: $0.publicKeys) }
    }
}

/// One pool of the account: how the relay lists it, the versions of the pool key this member holds, and its state once
/// the snapshot came.
public struct PoolBoard: Equatable, Sendable {
    public let summary: PoolSummary
    public private(set) var keyring: PoolKeyring
    public private(set) var state: PoolState?

    /// Nil when the member's copy of the pool key does not open with the account key.
    public init?(summary: PoolSummary, vault: SessionVault) {
        guard let joined = vault.poolKey(from: summary.key, poolId: summary.id) else { return nil }
        self.summary = summary
        keyring = PoolKeyring(key: joined.key, version: joined.version)
    }

    public var id: String { summary.id }
    public var poolVault: PoolVault { PoolVault(keyring: keyring) }
    /// Its name, as soon as the listing opens.
    public var name: String {
        state?.info?.name ?? poolVault.open(summary.info, as: PoolInfo.self)?.name ?? String(core: "A pool")
    }

    /// Folds a change in, opening newer versions of the pool key as they come. False when the pool is gone.
    public mutating func take(_ update: PoolUpdate, account: String, vault: SessionVault) -> Bool {
        if case .snapshot(let snapshot) = update {
            state = PoolState(snapshot: snapshot, vault: poolVault)
            // Blobs sealed with a version the snapshot's own wraps open: read again with it.
            if follow(account: account, vault: vault) { state = PoolState(snapshot: snapshot, vault: poolVault) }
            return true
        }
        guard var current = state else { return !isRemoved(update) }
        guard current.apply(update, vault: poolVault) else { return false }
        state = current
        switch update {
        case .key, .member: _ = follow(account: account, vault: vault)
        default: break
        }
        return true
    }

    /// Opens the versions wrapped for this member. True when one was added.
    private mutating func follow(account: String, vault: SessionVault) -> Bool {
        guard let state else { return false }
        let resolved = PoolKeys.resolve(
            joined: keyring, secret: vault.poolMemberSecret(state.own.secret, poolId: id), wraps: state.own.wraps,
            members: state.memberWires,
            poolId: id, account: account)
        let added = resolved.versions.filter { keyring.key($0) == nil }
        for version in added { if let key = resolved.key(version) { keyring.add(version: version, key: key) } }
        return !added.isEmpty
    }

    private func isRemoved(_ update: PoolUpdate) -> Bool {
        if case .removed = update { return true }
        return false
    }

    public static func == (a: PoolBoard, b: PoolBoard) -> Bool {
        a.summary == b.summary && a.keyring.versions == b.keyring.versions && a.state == b.state
    }
}
