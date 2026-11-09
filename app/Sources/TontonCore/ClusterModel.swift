import Foundation

// What the notch shows of a cluster, worked out from its state alone, as web/site/clusters/model.ts does for the website
// and the island: the roster by member and machine, who wrote a post and what it says in a line, the claims still held,
// the clock, and what one of the account's sessions shows the others when it is put in.

extension ClusterState.Session: Identifiable {
    public var id: String { "\(account)/\(session)" }
}

extension ClusterState.Member: Identifiable {
    public var id: String { account }
}

public enum ClusterModel {
    public struct Machine: Equatable, Sendable, Identifiable {
        /// The machine's id when the relay attests it, else its name.
        public let key: String
        public let name: String
        public let sessions: [ClusterState.Session]
        public var id: String { key }
    }

    public struct Member: Equatable, Sendable, Identifiable {
        public let account: String
        public let name: String
        public let role: ClusterRole
        /// This account.
        public let mine: Bool
        public let machines: [Machine]
        public let sessions: Int
        public var id: String { account }
    }

    /// Busy sessions first, so that who is doing what reads at a glance.
    private static let order = ["permission", "waiting", "working", "starting", "idle", "error", "ended", "offline"]

    public static func memberName(_ state: ClusterState, account: String) -> String {
        let name = state.members.first { $0.account == account }?.profile?.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return name?.isEmpty == false ? name ?? "" : String(core: "A member")
    }

    public static func sessionName(_ session: ClusterState.Session) -> String {
        let candidates = [session.profile?.name, session.profile?.project].compactMap {
            $0?.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return candidates.first { !$0.isEmpty } ?? String(core: "A session")
    }

    /// Every member with its sessions by machine: this account first, then the owner, then by name.
    public static func roster(_ state: ClusterState, account: String?) -> [Member] {
        func rank(_ status: String?) -> Int { status.flatMap { order.firstIndex(of: $0) } ?? order.count }
        let members = state.members.map { member in
            let sessions = state.sessions.filter { $0.account == member.account }
                .sorted {
                    rank($0.status) != rank($1.status)
                        ? rank($0.status) < rank($1.status)
                        : sessionName($0).localizedStandardCompare(sessionName($1)) == .orderedAscending
                }
            var machines: [Machine] = []
            for session in sessions {
                let name = session.profile?.machine?.trimmingCharacters(in: .whitespacesAndNewlines)
                let label = name?.isEmpty == false ? name ?? "" : String(core: "A machine")
                let key = session.machine ?? label
                if let index = machines.firstIndex(where: { $0.key == key }) {
                    machines[index] = Machine(key: key, name: machines[index].name, sessions: machines[index].sessions + [session])
                } else {
                    machines.append(Machine(key: key, name: label, sessions: [session]))
                }
            }
            return Member(
                account: member.account, name: memberName(state, account: member.account), role: member.role,
                mine: member.account == account,
                machines: machines.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }, sessions: sessions.count)
        }
        return members.sorted { a, b in
            if a.mine != b.mine { return a.mine }
            if (a.role == .owner) != (b.role == .owner) { return a.role == .owner }
            let byName = a.name.localizedStandardCompare(b.name)
            return byName == .orderedSame ? a.account < b.account : byName == .orderedAscending
        }
    }

    /// What a session is doing, as the roster says it: offline, waiting for its agent to take the order, or its status.
    /// Another member's session waits for its owner, not for whoever reads.
    public static func state(of session: ClusterState.Session, mine: Bool = false) -> String {
        if !session.online { return String(core: "Offline") }
        if !session.ready { return String(core: "Waiting for its agent") }
        guard let status = session.status.flatMap(SessionStatus.init(rawValue:)) else { return "" }
        return status == .waiting && !mine ? String(core: "Waiting for its owner") : status.label
    }

    /// The status the dot shows: offline unless its agent is there.
    public static func status(of session: ClusterState.Session) -> SessionStatus {
        session.online ? session.status.flatMap(SessionStatus.init(rawValue:)) ?? .idle : .offline
    }

    /// Its project, branch, tool and model, in one line.
    public static func facts(_ profile: ClusterSessionProfile?) -> String {
        guard let profile else { return "" }
        return [profile.project, profile.branch, toolLabel(profile.tool), profile.model.map(ModelName.display)]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    public static func toolLabel(_ tool: String?) -> String? {
        switch tool {
        case "claude": CodingTool.claudeCode.label
        case "opencode": CodingTool.openCode.label
        case "codex": CodingTool.codex.label
        default: nil
        }
    }

    /// Who wrote a post, as sessions see it in their envelope: `name · machine · tool`.
    public static func author(_ state: ClusterState, account: String, session: String?) -> String {
        let name = memberName(state, account: account)
        guard let session else { return name }
        let profile = state.sessions.first { $0.account == account && $0.session == session }?.profile
        return ([name, profile?.machine?.trimmingCharacters(in: .whitespacesAndNewlines), toolLabel(profile?.tool)] as [String?])
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    /// Who a post is for, in a few words; nil for everyone.
    public static func recipients(_ state: ClusterState, _ body: ClusterPostBody?) -> String? {
        guard let to = body?.to, !to.isEmpty else { return nil }
        return to.map { target in
            let member = memberName(state, account: target.account)
            guard let id = target.session, let session = state.sessions.first(where: { $0.account == target.account && $0.session == id })
            else { return member }
            return "\(sessionName(session)) (\(member))"
        }
        .joined(separator: ", ")
    }

    /// An event in a line: `push · main · 3`, `build · failed`.
    public static func eventLine(_ event: ClusterEvent?) -> String? {
        guard let event else { return nil }
        let parts: [String?] = [event.type, event.ref, event.count.map(String.init), event.ok == false ? String(core: "failed") : nil]
        return parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// A shared file in a line: `hero.png · image/png · 12 KB`.
    public static func fileLine(_ file: ClusterFileRef?) -> String? {
        guard let file else { return nil }
        return "\(file.name) · \(file.type) · \(max(1, Int((Double(file.size) / 1024).rounded()))) KB"
    }

    public static func kindLabel(_ kind: ClusterPostKind) -> String {
        switch kind {
        case .message: String(core: "Message")
        case .ask: String(core: "Question")
        case .answer: String(core: "Answer")
        case .event: String(core: "Event")
        case .claim: String(core: "Claim")
        case .file: String(core: "File")
        case .notice: String(core: "Notice")
        }
    }

    /// The posts, newest first, of one kind or all of them.
    public static func feed(_ state: ClusterState, kind: ClusterPostKind? = nil) -> [ClusterState.Post] {
        state.posts.reversed().filter { kind == nil || $0.body?.kind == kind }
    }

    /// The post a reply answers or follows, when it is still among the ones kept.
    public static func replied(_ post: ClusterState.Post, in state: ClusterState) -> ClusterState.Post? {
        guard let id = post.body?.replyTo else { return nil }
        return state.posts.first { $0.id == id }
    }

    /// The claims still held, newest first; lapsed ones are left out.
    public static func heldClaims(_ claims: [ClusterClaim], now: Date = Date()) -> [ClusterClaim] {
        claims.filter { claim in claim.until.flatMap(date).map { $0 > now } ?? true }
            .sorted { (date($0.at) ?? .distantPast) > (date($1.at) ?? .distantPast) }
    }

    /// A date the web or an agent wrote, with or without its milliseconds.
    public static func date(_ text: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    /// As JavaScript's `toISOString` writes it.
    public static func isoString(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    /// The live sessions of this account that are not in the cluster yet: only their owner puts them in.
    public static func outside(_ sessions: [SessionSummary], of state: ClusterState, account: String) -> [SessionSummary] {
        let inside = Set(state.sessions.filter { $0.account == account }.map(\.session))
        return sessions.filter { $0.agentOnline && $0.status.isLive && !inside.contains($0.id) }
    }

    /// What the cluster sees of one of this account's sessions: names and labels, never a full path. Its agent keeps the
    /// status line up to date.
    public static func profile(of session: SessionSummary) -> ClusterSessionProfile {
        func text(_ value: String?) -> String? {
            let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return trimmed.isEmpty ? nil : String(trimmed.prefix(200))
        }
        return ClusterSessionProfile(
            name: text(session.name ?? session.title), project: text(session.project), machine: text(session.machine),
            tool: session.codingTool.command, model: text(session.model), branch: text(session.branch))
    }

    // MARK: The clock

    public struct Mark: Equatable, Sendable, Identifiable {
        public let name: String
        public let at: Date
        public let passed: Bool
        public var id: String { "\(name)@\(at.timeIntervalSince1970)" }
    }

    public struct Clock: Equatable, Sendable {
        /// Seconds to the deadline, 0 once it passed; nil without a deadline.
        public let left: TimeInterval?
        public let deadline: Date?
        public let label: String?
        public let ended: Bool
        /// The last hour: the notch shows the clock in red.
        public let lastHour: Bool
        public let marks: [Mark]
        public let next: Mark?
    }

    /// The clock at `now`: what is left, and the milestones in order.
    public static func clock(_ clock: ClusterClock?, now: Date = Date()) -> Clock {
        let deadline = clock?.deadline.flatMap(date)
        let left = deadline.map { max(0, $0.timeIntervalSince(now)) }
        let marks = (clock?.milestones ?? [])
            .compactMap { mark in date(mark.at).map { Mark(name: mark.name, at: $0, passed: $0 <= now) } }
            .sorted { $0.at < $1.at }
        return Clock(
            left: left, deadline: deadline, label: left.map(timeLeft), ended: left == 0,
            lastHour: left.map { $0 > 0 && $0 <= 3600 } ?? false,
            marks: marks, next: marks.first { !$0.passed })
    }

    public static func timeLeft(_ seconds: TimeInterval) -> String {
        if seconds <= 0 { return String(core: "Time is up") }
        if seconds < 60 { return String(core: "Under a minute left") }
        let minutes = Int(seconds / 60)
        if minutes < 60 { return String(core: "\(minutes) min left") }
        let (hours, rest) = (minutes / 60, minutes % 60)
        if hours < 24 {
            return rest == 0 ? String(core: "\(hours) h left") : String(core: "\(hours) h \(rest < 10 ? "0\(rest)" : "\(rest)") min left")
        }
        let (days, restHours) = (hours / 24, hours % 24)
        return restHours == 0 ? String(core: "\(days) d left") : String(core: "\(days) d \(restHours) h left")
    }
}

extension ClusterDelivery {
    public var label: String {
        switch self {
        case .live: String(core: "Live")
        case .digest: String(core: "Digest")
        case .muted: String(core: "Muted")
        }
    }

    public var detail: String {
        switch self {
        case .live: String(core: "Posts reach it as they come")
        case .digest: String(core: "Gathered for its next prompt")
        case .muted: String(core: "Nothing reaches it")
        }
    }
}

/// Why a session its owner set to live gets digests: it skips permission prompts, or it is a codex nothing drives (a plain
/// `codex` reads posts only at its next prompt; `tonton codex` takes them live).
public enum ClusterDigestReason: Equatable, Sendable {
    case prompts, codex

    public var text: String {
        switch self {
        case .prompts: String(core: "Live → digest: skips permission prompts")
        case .codex: String(core: "Live → digest: a codex started without tonton codex reads posts at its next prompt")
        }
    }
}

/// What the owner of a session chose for it in a cluster (docs/cluster.md, The rule).
public struct ClusterSessionChoice: Codable, Equatable, Sendable {
    public var delivery: ClusterDelivery
    /// Live even though the session skips permission prompts: it gets a digest otherwise.
    public var liveWithoutPrompts: Bool

    public init(delivery: ClusterDelivery = .live, liveWithoutPrompts: Bool = false) {
        self.delivery = delivery
        self.liveWithoutPrompts = delivery == .live && liveWithoutPrompts
    }

    public static let standard = ClusterSessionChoice()

    public var label: String { liveWithoutPrompts ? String(core: "Live anyway") : delivery.label }

    /// Why the session, set to live, gets digests, as its agent says (docs/cluster.md, Delivery): the notch says so, with
    /// Live anyway one click away when it skips permission prompts. Nil when it gets what was chosen, or for an older
    /// agent, which says nothing. Mirrors `clusterDigestReason` in shared/cluster.ts.
    public func digestReason(_ profile: ClusterSessionProfile?) -> ClusterDigestReason? {
        guard delivery == .live, let profile, profile.delivery == .digest else { return nil }
        if profile.skipsPrompts == true && !liveWithoutPrompts { return .prompts }
        return profile.tool == CodingTool.codex.command ? .codex : nil
    }

    /// The choice, as the session really takes the posts.
    public func label(for profile: ClusterSessionProfile?) -> String {
        digestReason(profile)?.text ?? label
    }

    /// What Live anyway does, for a session that skips permission prompts.
    public static var anywayDetail: String {
        String(core: "Posts reach it as they come, though it skips permission prompts")
    }

    /// The agent applies the rule, and an older one does not say when it did: the notch says it for every session.
    public static var promptsNote: String {
        String(core: "A session that skips permission prompts gets a digest unless you choose Live anyway.")
    }
}

/// The choice made last for each session in each cluster. The relay keeps the order sealed for the session's agent alone,
/// so the notch remembers what it sent, as the website does in its own storage.
public struct ClusterChoices: Codable, Equatable, Sendable {
    private var choices: [String: ClusterSessionChoice]

    public init() { choices = [:] }

    /// Saved choices, or none when they do not read.
    public init(data: Data?) {
        self.choices = data.flatMap { try? JSONDecoder().decode([String: ClusterSessionChoice].self, from: $0) } ?? [:]
    }

    public var data: Data { (try? JSONEncoder().encode(choices)) ?? Data() }

    public func choice(cluster: String, session: String) -> ClusterSessionChoice {
        choices["\(cluster)/\(session)"] ?? .standard
    }

    /// These choices with one more, the others unchanged.
    public func setting(_ choice: ClusterSessionChoice, cluster: String, session: String) -> ClusterChoices {
        var next = self
        next.choices["\(cluster)/\(session)"] = choice
        return next
    }

    /// Without a cluster's choices, once the account left it.
    public func without(cluster: String) -> ClusterChoices {
        var next = self
        next.choices = choices.filter { !$0.key.hasPrefix("\(cluster)/") }
        return next
    }
}

/// The clock as its owner edits it: a deadline, if any, and the milestones on the way.
public struct ClusterClockDraft: Equatable, Sendable {
    public struct Mark: Equatable, Sendable, Identifiable {
        public let id: UUID
        public var name: String
        public var at: Date

        public init(id: UUID = UUID(), name: String, at: Date) {
            (self.id, self.name, self.at) = (id, name, at)
        }
    }

    public var hasDeadline: Bool
    public var deadline: Date
    public var marks: [Mark]

    /// The clock as it is, or a deadline a day from now to start from.
    public init(_ clock: ClusterClock?, now: Date = Date()) {
        let deadline = clock?.deadline.flatMap(ClusterModel.date)
        hasDeadline = deadline != nil
        self.deadline = deadline ?? now.addingTimeInterval(24 * 3600)
        marks = (clock?.milestones ?? []).compactMap { mark in ClusterModel.date(mark.at).map { Mark(name: mark.name, at: $0) } }
    }

    /// A new milestone, halfway to the deadline.
    public func adding(now: Date = Date()) -> ClusterClockDraft {
        var next = self
        let end = hasDeadline ? deadline : now.addingTimeInterval(24 * 3600)
        next.marks = marks + [Mark(name: "", at: Date(timeIntervalSince1970: (now.timeIntervalSince1970 + end.timeIntervalSince1970) / 2))]
        return next
    }

    /// What is sealed: milestones without a name are left out, the others in order, their names at most 120 characters.
    public func clock(startedAt: String?, now: Date = Date()) -> ClusterClock {
        let milestones = marks.compactMap { mark -> ClusterMilestone? in
            let name = mark.name.trimmingCharacters(in: .whitespacesAndNewlines)
            return name.isEmpty ? nil : ClusterMilestone(name: String(name.prefix(120)), at: ClusterModel.isoString(mark.at))
        }
        let sorted = milestones.sorted { (ClusterModel.date($0.at) ?? .distantPast) < (ClusterModel.date($1.at) ?? .distantPast) }
        return ClusterClock(
            startedAt: startedAt ?? ClusterModel.isoString(now), deadline: hasDeadline ? ClusterModel.isoString(deadline) : nil,
            milestones: sorted)
    }
}

extension MachineInfo {
    /// Agents from this version take a session into a cluster; older ones ignore the order, so the notch does not offer it
    /// (docs/cluster.md, Versions). The agent's side is #308: this is the release it is expected in.
    public static let clustersSince = "0.10.0"

    public var joinsClusters: Bool { runs(atLeast: Self.clustersSince) }
}
