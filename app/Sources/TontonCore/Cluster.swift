import Foundation

// Clusters (docs/cluster.md): the sessions of several machines and people, talking to each other. No orchestrator, no
// tasks, nothing that drives a session of another account: only posts, a few shared documents and who is there. Mirrors
// shared/cluster-protocol.ts, shared/cluster.ts, shared/cluster-link.ts and shared/cluster-wire.ts. What the relay keeps in
// clear is ids, roles, revisions and times; the rest is sealed with the cluster key, which the members share and the relay
// never gets. The key's versions, member keys and wraps are the pools' (PoolKeys.swift), scoped with `Cluster.keyScope`.

public enum Cluster {
    /// The name a cluster's member keys and wraps are made for: never a pool's id, which has no `:`.
    public static func keyScope(_ clusterId: String) -> String { "cluster:\(clusterId)" }

    /// True when a post is for this session: for everyone, for every session of its account, or for it by name.
    public static func post(_ body: ClusterPostBody, isFor account: String, session: String) -> Bool {
        guard let to = body.to, !to.isEmpty else { return true }
        return to.contains { $0.account == account && ($0.session == nil || $0.session == session) }
    }

    /// The shape the relay takes for a document's name.
    static func isDocName(_ name: String) -> Bool { name.wholeMatch(of: #/[a-z][a-z0-9-]{0,23}/#) != nil }

    /// How many posts a client keeps in memory, as the web does.
    static let keptPosts = 500
}

public enum ClusterRole: String, Codable, Sendable {
    case owner, member
}

// MARK: Invites

/// An invite to a cluster, as a link or a QR code: `tontoncluster1.` and base64url JSON of the relay, the cluster, the
/// invite token and the cluster key.
public struct ClusterInvite: Equatable, Sendable {
    public let relay: String
    public let cluster: String
    /// `tc_…`: joins the cluster, nothing else.
    public let token: String
    /// Base64url AES-256 cluster key.
    public let key: String
    public let version: Int

    private static let prefix = "tontoncluster1."
    private struct Payload: Codable {
        let relay: String
        let cluster: String
        let token: String
        let key: String
        let v: Int
    }

    public init(relay: String, cluster: String, token: String, key: String, version: Int) {
        (self.relay, self.cluster, self.token, self.key, self.version) = (relay, cluster, token, key, version)
    }

    public init?(string: String) {
        var trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        // A link to the relay's website carries the invite after its `#`.
        if let hash = trimmed.lastIndex(of: "#") { trimmed = String(trimmed[trimmed.index(after: hash)...]) }
        guard trimmed.hasPrefix(Self.prefix), let data = Data(base64URLEncoded: String(trimmed.dropFirst(Self.prefix.count))),
            let payload = try? JSONDecoder().decode(Payload.self, from: data),
            let relay = URL(string: payload.relay), ["https", "http"].contains(relay.scheme ?? ""),
            payload.cluster.wholeMatch(of: #/[A-Za-z0-9_-]{12}/#) != nil,
            payload.token.wholeMatch(of: #/tc_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}/#) != nil,
            (try? E2E.key(fromBase64URL: payload.key)) != nil, payload.v >= 1
        else { return nil }
        self.init(
            relay: RelayAPI.normalize(payload.relay), cluster: payload.cluster, token: payload.token, key: payload.key,
            version: payload.v)
    }

    /// What the owner hands out.
    public var string: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let payload = Payload(relay: relay, cluster: cluster, token: token, key: key, v: version)
        return Self.prefix + ((try? encoder.encode(payload)) ?? Data()).base64URLEncodedString()
    }

    /// The invite as a link to the relay's website: it stays after the `#`, which browsers never send.
    public var link: String { "\(relay)/#\(string)" }
}

// MARK: Sealed with the account key

/// A member's own copy of the cluster key, kept on the relay so its other devices and its machines' agents get it.
struct ClusterKeyGrant: Codable, Equatable {
    let clusterId: String
    let key: String
    let version: Int
}

/// How a session takes posts, as its owner chose: as they come, gathered for its next prompt, or not at all.
public enum ClusterDelivery: String, Codable, Sendable, CaseIterable {
    case live, digest, muted

    /// What its owner chose, or live by default; a digest for a session that skips permission prompts unless its owner
    /// turned live delivery on for it (docs/cluster.md, The rule).
    public static func of(_ order: ClusterSessionOrder, skipsPrompts: Bool) -> ClusterDelivery {
        let chosen = order.delivery ?? .live
        return chosen == .live && skipsPrompts && order.liveWithoutPrompts != true ? .digest : chosen
    }
}

/// From the owner's app, or its own agent, to one of its sessions' agents: be in this cluster, with its key.
public struct ClusterSessionOrder: Codable, Equatable, Sendable {
    public let clusterId: String
    public let sessionId: String
    public let key: String
    public let version: Int
    public let issuedAt: String
    public var delivery: ClusterDelivery? = nil
    /// The owner turned live delivery on for a session that skips permission prompts.
    public var liveWithoutPrompts: Bool? = nil

    private enum Keys: String, CodingKey { case clusterId, sessionId, key, version, issuedAt, delivery, liveWithoutPrompts }

    init(
        clusterId: String, sessionId: String, key: String, version: Int, issuedAt: String, delivery: ClusterDelivery? = nil,
        liveWithoutPrompts: Bool? = nil
    ) {
        (self.clusterId, self.sessionId, self.key, self.version, self.issuedAt) = (clusterId, sessionId, key, version, issuedAt)
        (self.delivery, self.liveWithoutPrompts) = (delivery, liveWithoutPrompts)
    }

    /// An unknown delivery reads as none, like the web's, rather than refusing the whole order.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        clusterId = try c.decode(String.self, forKey: .clusterId)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        key = try c.decode(String.self, forKey: .key)
        version = try c.decode(Int.self, forKey: .version)
        issuedAt = try c.decode(String.self, forKey: .issuedAt)
        delivery = (try? c.decodeIfPresent(String.self, forKey: .delivery)).flatMap { $0.flatMap(ClusterDelivery.init(rawValue:)) }
        liveWithoutPrompts = (try? c.decodeIfPresent(Bool.self, forKey: .liveWithoutPrompts)) == true ? true : nil
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(clusterId, forKey: .clusterId)
        try c.encode(sessionId, forKey: .sessionId)
        try c.encode(key, forKey: .key)
        try c.encode(version, forKey: .version)
        try c.encode(issuedAt, forKey: .issuedAt)
        try c.encodeIfPresent(delivery, forKey: .delivery)
        try c.encodeIfPresent(liveWithoutPrompts, forKey: .liveWithoutPrompts)
    }
}

extension SessionVault {
    /// The member's copy of the cluster key, for the relay to keep.
    public func sealClusterKeyGrant(clusterId: String, key clusterKey: String, version: Int) throws -> String {
        try E2E.seal(ClusterKeyGrant(clusterId: clusterId, key: clusterKey, version: version), with: key)
    }

    /// The cluster key from the member's copy, if it opens with the account key and is for this cluster.
    public func clusterKey(from grant: String, clusterId: String) -> (key: String, version: Int)? {
        guard let opened = try? E2E.open(grant, as: ClusterKeyGrant.self, with: key), opened.clusterId == clusterId,
            (try? E2E.key(fromBase64URL: opened.key)) != nil, opened.version >= 1
        else { return nil }
        return (opened.key, opened.version)
    }

    /// Puts one of the account's sessions in a cluster: its agent takes it only if it opens with the account key and
    /// names that session and that cluster.
    public func sealClusterSessionOrder(
        clusterId: String, sessionId: String, key clusterKey: String, version: Int, delivery: ClusterDelivery? = nil,
        liveWithoutPrompts: Bool = false, issuedAt: Date = Date()
    ) throws -> String {
        let order = ClusterSessionOrder(
            clusterId: clusterId, sessionId: sessionId, key: clusterKey, version: version,
            issuedAt: ISO8601DateFormatter().string(from: issuedAt), delivery: delivery, liveWithoutPrompts: liveWithoutPrompts ? true : nil
        )
        return try E2E.seal(order, with: key)
    }

    /// The order as a session's agent checks it: sealed with the account key, for this session and this cluster.
    public func openClusterSessionOrder(_ sealed: String, sessionId: String, clusterId: String) -> ClusterSessionOrder? {
        guard let order = try? E2E.open(sealed, as: ClusterSessionOrder.self, with: key), order.sessionId == sessionId,
            order.clusterId == clusterId, (try? E2E.key(fromBase64URL: order.key)) != nil, order.version >= 1
        else { return nil }
        return order
    }

    /// A new key pair for this member of a cluster: its private key sealed with the account key, its public key with the
    /// cluster key.
    public func newClusterMemberKeys(clusterId: String, account: String, keyring: PoolKeyring) throws -> (secret: String, publicKey: String)
    {
        try newPoolMemberKeys(poolId: Cluster.keyScope(clusterId), account: account, keyring: keyring)
    }

    /// Every version of the cluster key this member holds, from its grant, its private key and the wraps made for it.
    public func clusterKeyring(
        grant: String, own: PoolOwnKeys?, members: [ClusterMemberWire], clusterId: String, account: String
    ) -> PoolKeyring? {
        guard let joined = clusterKey(from: grant, clusterId: clusterId) else { return nil }
        let scope = Cluster.keyScope(clusterId)
        // The pools' resolution reads only each member's account and public keys.
        let keyed = members.map {
            PoolMemberWire(account: $0.account, role: .member, joinedAt: $0.joinedAt, profile: nil, publicKeys: $0.publicKeys)
        }
        return PoolKeys.resolve(
            joined: PoolKeyring(key: joined.key, version: joined.version), secret: poolMemberSecret(own?.secret, poolId: scope),
            wraps: own?.wraps ?? [], members: keyed, poolId: scope, account: account)
    }
}

// MARK: What another member sealed, read leniently

/// Any JSON, to read what another member sealed field by field: a field of the wrong type is dropped, never trusted.
enum ClusterJSON: Decodable, Equatable, Sendable {
    case string(String), number(Double), bool(Bool), array([ClusterJSON]), object([String: ClusterJSON]), null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let value = try? c.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? c.decode(Double.self) {
            self = .number(value)
        } else if let value = try? c.decode(String.self) {
            self = .string(value)
        } else if let value = try? c.decode([ClusterJSON].self) {
            self = .array(value)
        } else {
            self = .object(try c.decode([String: ClusterJSON].self))
        }
    }

    subscript(_ key: String) -> ClusterJSON? {
        if case .object(let fields) = self { return fields[key] }
        return nil
    }

    var isObject: Bool {
        if case .object = self { return true }
        return false
    }

    var string: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var bool: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    var array: [ClusterJSON]? {
        if case .array(let value) = self { return value }
        return nil
    }

    /// A whole number, zero or more.
    var count: Int? {
        guard case .number(let value) = self, value >= 0, value == value.rounded(), value < 9_007_199_254_740_992 else { return nil }
        return Int(value)
    }

    func text(_ max: Int) -> String? { string.map { String($0.prefix(max)) } }

    /// The strings of a list, at most 200 of at most `max` characters each.
    func texts(_ max: Int = 1024) -> [String]? {
        array.map { $0.compactMap(\.string).prefix(200).map { String($0.prefix(max)) } }
    }

    /// A date and time JavaScript reads too.
    var date: String? {
        guard let value = string else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return ISO8601DateFormatter().date(from: value) != nil || fractional.date(from: value) != nil ? value : nil
    }
}

/// A payload sealed with the cluster key, read from its JSON as the web reads it.
protocol ClusterPayload: Encodable {
    init?(json: ClusterJSON)
}

/// The longest text kept from a message another member wrote.
private let maxText = 16 * 1024

// MARK: Sealed with the cluster key

public struct ClusterInfo: Codable, Equatable, Sendable, ClusterPayload {
    public var name: String
    /// What the cluster is for, in a sentence.
    public var about: String?

    public init(name: String, about: String? = nil) {
        (self.name, self.about) = (name, about)
    }

    init?(json: ClusterJSON) {
        guard json.isObject, let name = json["name"]?.text(200) else { return nil }
        self.init(name: name, about: json["about"]?.text(2000))
    }
}

public struct ClusterMemberProfile: Codable, Equatable, Sendable, ClusterPayload {
    public var name: String

    public init(name: String) { self.name = name }

    init?(json: ClusterJSON) {
        guard let name = json["name"]?.text(200) else { return nil }
        self.init(name: name)
    }
}

/// How a session shows in the cluster: set by its owner on joining, then kept up to date by its agent.
public struct ClusterSessionProfile: Codable, Equatable, Sendable, ClusterPayload {
    public var name: String?
    /// The project folder's name, never the full path.
    public var project: String?
    public var machine: String?
    /// `claude` or `opencode`.
    public var tool: String?
    public var model: String?
    public var branch: String?
    /// What the session says it is doing, and since when.
    public var status: String?
    public var statusAt: String?

    public init(
        name: String? = nil, project: String? = nil, machine: String? = nil, tool: String? = nil, model: String? = nil,
        branch: String? = nil, status: String? = nil, statusAt: String? = nil
    ) {
        (self.name, self.project, self.machine, self.tool) = (name, project, machine, tool)
        (self.model, self.branch, self.status, self.statusAt) = (model, branch, status, statusAt)
    }

    init?(json: ClusterJSON) {
        guard json.isObject else { return nil }
        let tool = json["tool"]?.string
        self.init(
            name: json["name"]?.text(200), project: json["project"]?.text(200), machine: json["machine"]?.text(200),
            tool: tool == "claude" || tool == "opencode" ? tool : nil, model: json["model"]?.text(200), branch: json["branch"]?.text(200),
            status: json["status"]?.text(500), statusAt: json["statusAt"]?.date)
    }
}

/// `message`, `ask`, `answer`, `event`, `claim`, `file`, `notice`. A post of a kind this client does not know reads as nil.
public enum ClusterPostKind: String, Codable, Sendable, CaseIterable {
    case message, ask, answer, event, claim, file, notice
}

/// Who a post is for: a session, or every session of a member when `session` is nil.
public struct ClusterTarget: Codable, Equatable, Sendable {
    public var account: String
    public var session: String?

    public init(account: String, session: String? = nil) {
        (self.account, self.session) = (account, session)
    }

    init?(json: ClusterJSON) {
        guard let account = json["account"]?.string else { return nil }
        self.init(account: account, session: json["session"]?.string)
    }
}

/// Something that happened: a push, a submit, a build. Readers skip types they don't know.
public struct ClusterEvent: Codable, Equatable, Sendable {
    /// `commit`, `push`, `submit`, `shelve`, `build`, `test`, `attention`, `custom`…
    public var type: String
    public var ok: Bool?
    /// A branch, a commit, a changelist.
    public var ref: String?
    public var paths: [String]?
    public var count: Int?

    public init(type: String, ok: Bool? = nil, ref: String? = nil, paths: [String]? = nil, count: Int? = nil) {
        (self.type, self.ok, self.ref, self.paths, self.count) = (type, ok, ref, paths, count)
    }

    init?(json: ClusterJSON) {
        guard json.isObject, let type = json["type"]?.text(64), !type.isEmpty else { return nil }
        self.init(type: type, ok: json["ok"]?.bool, ref: json["ref"]?.text(500), paths: json["paths"]?.texts(), count: json["count"]?.count)
    }
}

/// A small file shared through the cluster: its bytes are sealed apart.
public struct ClusterFileRef: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var size: Int
    /// A media type: `image/png`, `text/plain`…
    public var type: String
    /// Hex SHA-256 of the bytes.
    public var sha256: String

    init?(json: ClusterJSON) {
        guard json.isObject, let id = json["id"]?.string, let name = json["name"]?.string, let size = json["size"]?.count,
            let type = json["type"]?.string, let sha256 = json["sha256"]?.string, sha256.wholeMatch(of: #/[0-9a-f]{64}/#) != nil
        else { return nil }
        (self.id, self.name, self.size, self.type, self.sha256) = (
            String(id.prefix(64)), String(name.prefix(255)), size, String(type.prefix(127)), sha256
        )
    }
}

public struct ClusterPostBody: Codable, Equatable, Sendable, ClusterPayload {
    public var kind: ClusterPostKind
    public var text: String
    /// Nil: every session of the cluster.
    public var to: [ClusterTarget]?
    public var topic: String?
    /// The id of the post it answers or follows.
    public var replyTo: String?
    public var event: ClusterEvent?
    public var file: ClusterFileRef?

    public init(
        kind: ClusterPostKind, text: String, to: [ClusterTarget]? = nil, topic: String? = nil, replyTo: String? = nil,
        event: ClusterEvent? = nil
    ) {
        (self.kind, self.text, self.to, self.topic, self.replyTo, self.event) = (kind, text, to, topic, replyTo, event)
    }

    init?(json: ClusterJSON) {
        guard json.isObject, let kind = json["kind"]?.string.flatMap(ClusterPostKind.init(rawValue:)),
            let text = json["text"]?.text(maxText)
        else { return nil }
        let to = json["to"]?.array.map { $0.prefix(200).compactMap(ClusterTarget.init(json:)) }
        self.init(
            kind: kind, text: text, to: to?.isEmpty == false ? to : nil, topic: json["topic"]?.text(64), replyTo: json["replyTo"]?.text(64),
            event: json["event"].flatMap(ClusterEvent.init(json:)))
        file = json["file"].flatMap(ClusterFileRef.init(json:))
    }
}

/// `notes`: the shared board, conventions, interfaces and decisions.
public struct ClusterNotes: Codable, Equatable, Sendable, ClusterPayload {
    public var text: String

    public init(text: String) { self.text = text }

    init?(json: ClusterJSON) {
        guard let text = json["text"]?.text(1024 * 1024) else { return nil }
        self.init(text: text)
    }
}

/// A file, a folder or a glob held by a session.
public struct ClusterClaim: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    /// Relative to the project root, with `/`.
    public var paths: [String]
    public var reason: String?
    public var account: String
    public var session: String
    public var at: String
    public var until: String?

    public init(id: String, paths: [String], reason: String? = nil, account: String, session: String, at: String, until: String? = nil) {
        (self.id, self.paths, self.reason, self.account, self.session, self.at, self.until) = (
            id, paths, reason, account, session, at, until
        )
    }

    init?(json: ClusterJSON) {
        guard json.isObject, let id = json["id"]?.string, let paths = json["paths"]?.texts(), !paths.isEmpty,
            let account = json["account"]?.string, let session = json["session"]?.string, let at = json["at"]?.date
        else { return nil }
        self.init(
            id: String(id.prefix(64)), paths: paths, reason: json["reason"]?.text(500), account: account, session: session, at: at,
            until: json["until"]?.date)
    }
}

/// `claims`.
public struct ClusterClaims: Codable, Equatable, Sendable, ClusterPayload {
    public var claims: [ClusterClaim]

    public init(claims: [ClusterClaim]) { self.claims = claims }

    init?(json: ClusterJSON) {
        guard let list = json["claims"]?.array else { return nil }
        self.init(claims: list.prefix(1000).compactMap(ClusterClaim.init(json:)))
    }
}

public struct ClusterMilestone: Codable, Equatable, Sendable {
    public var name: String
    public var at: String

    public init(name: String, at: String) { (self.name, self.at) = (name, at) }

    init?(json: ClusterJSON) {
        guard let name = json["name"]?.text(200), !name.isEmpty, let at = json["at"]?.date else { return nil }
        self.init(name: name, at: at)
    }
}

/// `clock`: a deadline for everyone, and the marks on the way.
public struct ClusterClock: Codable, Equatable, Sendable, ClusterPayload {
    public var startedAt: String?
    public var deadline: String?
    public var milestones: [ClusterMilestone]?

    public init(startedAt: String? = nil, deadline: String? = nil, milestones: [ClusterMilestone]? = nil) {
        (self.startedAt, self.deadline, self.milestones) = (startedAt, deadline, milestones)
    }

    init?(json: ClusterJSON) {
        guard json.isObject else { return nil }
        self.init(
            startedAt: json["startedAt"]?.date, deadline: json["deadline"]?.date,
            milestones: json["milestones"]?.array.map { $0.prefix(50).compactMap(ClusterMilestone.init(json:)) })
    }
}

// MARK: What the relay sends

/// Decodes what it can, and leaves out what has the wrong shape.
private struct Lossy<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

extension KeyedDecodingContainer {
    /// A list whose items of the wrong shape are left out; the list itself must be there.
    fileprivate func lossy<T: Decodable>(_ type: T.Type, forKey key: Key) throws -> [T] {
        try decode([Lossy<T>].self, forKey: key).compactMap(\.value)
    }

    /// Present and null, or a string: missing is a wrong shape, as for the web.
    fileprivate func nullableText(forKey key: Key) throws -> String? {
        guard contains(key) else { throw DecodingError.keyNotFound(key, .init(codingPath: codingPath, debugDescription: "missing")) }
        return try decodeNil(forKey: key) ? nil : decode(String.self, forKey: key)
    }
}

/// A cluster as `GET /api/clusters` lists it for the account asking.
public struct ClusterSummary: Codable, Equatable, Sendable {
    public let id: String
    public let role: ClusterRole
    public let createdAt: String
    public let keyVersion: Int
    /// `ClusterInfo`, sealed with the cluster key.
    public let info: String
    /// `ClusterKeyGrant`, sealed with the account key: the version this member joined with.
    public let key: String
    public let members: Int
    /// The member's private key for the cluster, sealed with the account key.
    public let secret: String?
    /// Later versions of the cluster key, wrapped for this member.
    public let wraps: [PoolKeyWrapWire]

    private enum Keys: String, CodingKey { case id, role, createdAt, keyVersion, info, key, members, secret, wraps }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        (id, role, createdAt) = (
            try c.decode(String.self, forKey: .id), try c.decode(ClusterRole.self, forKey: .role),
            try c.decode(String.self, forKey: .createdAt)
        )
        (keyVersion, info, key, members) = (
            try c.decode(Int.self, forKey: .keyVersion), try c.decode(String.self, forKey: .info), try c.decode(String.self, forKey: .key),
            try c.decode(Int.self, forKey: .members)
        )
        secret = try c.decodeIfPresent(String.self, forKey: .secret)
        wraps = (try? c.lossy(PoolKeyWrapWire.self, forKey: .wraps)) ?? []
    }
}

public struct ClusterMemberWire: Codable, Equatable, Sendable {
    public let account: String
    public let role: ClusterRole
    public let joinedAt: String
    public let profile: String?
    /// Its public key, sealed with each version of the cluster key it was published under.
    public let publicKeys: [String]

    public init(account: String, role: ClusterRole, joinedAt: String, profile: String?, publicKeys: [String] = []) {
        (self.account, self.role, self.joinedAt, self.profile, self.publicKeys) = (account, role, joinedAt, profile, publicKeys)
    }

    private enum Keys: String, CodingKey { case account, role, joinedAt, profile, publicKeys }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        account = try c.decode(String.self, forKey: .account)
        role = try c.decode(ClusterRole.self, forKey: .role)
        joinedAt = try c.decode(String.self, forKey: .joinedAt)
        profile = try c.nullableText(forKey: .profile)
        publicKeys = try c.decode([String].self, forKey: .publicKeys)
    }
}

public struct ClusterSessionWire: Codable, Equatable, Sendable {
    public let account: String
    public let session: String
    /// The machine of its agent, as the relay attests it.
    public let machine: String?
    public let joinedAt: String
    public let profile: String?
    public let online: Bool
    public let ready: Bool
    /// The session's status, which the relay sees anyway.
    public let status: String?

    private enum Keys: String, CodingKey { case account, session, machine, joinedAt, profile, online, ready, status }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        account = try c.decode(String.self, forKey: .account)
        session = try c.decode(String.self, forKey: .session)
        machine = try c.decodeIfPresent(String.self, forKey: .machine)
        joinedAt = try c.decode(String.self, forKey: .joinedAt)
        profile = try c.nullableText(forKey: .profile)
        online = try c.decode(Bool.self, forKey: .online)
        ready = try c.decode(Bool.self, forKey: .ready)
        status = try c.decodeIfPresent(String.self, forKey: .status)
    }
}

/// A post, in the order the relay got them, with who wrote it as the relay attests it.
public struct ClusterPostWire: Codable, Equatable, Sendable {
    public let id: String
    public let seq: Int
    public let ts: String
    public let account: String
    /// Nil when it came from an app rather than a session.
    public let session: String?
    public let machine: String?
    public let blob: String

    private enum Keys: String, CodingKey { case id, seq, ts, account, session, machine, blob }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        seq = try c.decode(Int.self, forKey: .seq)
        ts = try c.decode(String.self, forKey: .ts)
        account = try c.decode(String.self, forKey: .account)
        session = try c.nullableText(forKey: .session)
        machine = try c.decodeIfPresent(String.self, forKey: .machine)
        blob = try c.decode(String.self, forKey: .blob)
        guard seq >= 0 else { throw DecodingError.dataCorruptedError(forKey: .seq, in: c, debugDescription: "negative") }
    }
}

/// A shared document: its revision goes up with every change.
public struct ClusterDocWire: Codable, Equatable, Sendable {
    public let name: String
    public let rev: Int
    public let updatedAt: String
    public let account: String
    public let session: String?
    public let machine: String?
    public let blob: String

    private enum Keys: String, CodingKey { case name, rev, updatedAt, account, session, machine, blob }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        name = try c.decode(String.self, forKey: .name)
        rev = try c.decode(Int.self, forKey: .rev)
        updatedAt = try c.decode(String.self, forKey: .updatedAt)
        account = try c.decode(String.self, forKey: .account)
        session = try c.nullableText(forKey: .session)
        machine = try c.decodeIfPresent(String.self, forKey: .machine)
        blob = try c.decode(String.self, forKey: .blob)
        guard Cluster.isDocName(name), rev >= 0 else {
            throw DecodingError.dataCorruptedError(forKey: .name, in: c, debugDescription: "not a document")
        }
    }
}

public struct ClusterSnapshot: Codable, Equatable, Sendable {
    public let id: String
    public let createdAt: String
    public let keyVersion: Int
    public let info: String
    public let members: [ClusterMemberWire]
    public let sessions: [ClusterSessionWire]
    /// The latest ones only, oldest first.
    public let posts: [ClusterPostWire]
    public let docs: [ClusterDocWire]
    /// For the account it was sent to: its private key and the cluster keys wrapped for it.
    public let own: PoolOwnKeys?

    private enum Keys: String, CodingKey { case id, createdAt, keyVersion, info, members, sessions, posts, docs, own }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        keyVersion = try c.decode(Int.self, forKey: .keyVersion)
        info = try c.decode(String.self, forKey: .info)
        members = try c.lossy(ClusterMemberWire.self, forKey: .members)
        sessions = try c.lossy(ClusterSessionWire.self, forKey: .sessions)
        posts = try c.lossy(ClusterPostWire.self, forKey: .posts)
        docs = try c.lossy(ClusterDocWire.self, forKey: .docs)
        own = Self.own(c)
    }

    /// The member's own keys: left out when their shape is wrong, and its wraps of the wrong shape dropped.
    private static func own(_ c: KeyedDecodingContainer<Keys>) -> PoolOwnKeys? {
        // `try?` would flatten a null secret into no keys at all.
        let secret: String?
        guard let own = try? c.nestedContainer(keyedBy: OwnKeys.self, forKey: .own) else { return nil }
        do { secret = try own.nullableText(forKey: .secret) } catch { return nil }
        let wraps = ((try? own.lossy(PoolKeyWrapWire.self, forKey: .wraps)) ?? []).filter { $0.version >= 2 }
        return PoolOwnKeys(secret: secret, wraps: wraps)
    }

    private enum OwnKeys: String, CodingKey { case secret, wraps }
}

/// The cluster messages of the relay, for the apps and the website. One this client does not know, or with the wrong
/// shape, fails to decode and is dropped.
public enum ClusterUpdate: Decodable, Equatable, Sendable {
    case snapshot(ClusterSnapshot)
    case post(clusterId: String, ClusterPostWire)
    case doc(clusterId: String, ClusterDocWire)
    case info(clusterId: String, info: String, keyVersion: Int)
    case member(clusterId: String, ClusterMemberWire)
    case memberLeft(clusterId: String, account: String)
    case session(clusterId: String, ClusterSessionWire)
    case sessionLeft(clusterId: String, account: String, session: String)
    /// To one member: the cluster key was rotated, here is the new version wrapped for it.
    case key(clusterId: String, PoolKeyWrapWire)
    /// A document sent over an older revision was refused: the current one, if any.
    case conflict(clusterId: String, name: String, current: ClusterDocWire?)
    case removed(clusterId: String)
    case error(clusterId: String, message: String)

    private enum Keys: String, CodingKey {
        case t, cluster, clusterId, post, doc, info, keyVersion, member, account, session, wrap, name, current, message
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        func value<T: Decodable>(_ key: Keys) throws -> T { try c.decode(T.self, forKey: key) }
        let t: String = try value(.t)
        if t == "cluster_snapshot" {
            self = .snapshot(try value(.cluster))
            return
        }
        let id: String = try value(.clusterId)
        switch t {
        case "cluster_post": self = .post(clusterId: id, try value(.post))
        case "cluster_doc": self = .doc(clusterId: id, try value(.doc))
        case "cluster_info": self = .info(clusterId: id, info: try value(.info), keyVersion: try value(.keyVersion))
        case "cluster_member": self = .member(clusterId: id, try value(.member))
        case "cluster_member_left": self = .memberLeft(clusterId: id, account: try value(.account))
        case "cluster_session": self = .session(clusterId: id, try value(.session))
        case "cluster_session_left":
            self = .sessionLeft(clusterId: id, account: try value(.account), session: try c.decode(String.self, forKey: .session))
        case "cluster_key":
            let wrap: PoolKeyWrapWire = try value(.wrap)
            guard wrap.version >= 2 else { throw DecodingError.dataCorruptedError(forKey: .wrap, in: c, debugDescription: "version") }
            self = .key(clusterId: id, wrap)
        case "cluster_conflict":
            guard c.contains(.current) else { throw DecodingError.keyNotFound(Keys.current, .init(codingPath: [], debugDescription: "")) }
            self = .conflict(clusterId: id, name: try value(.name), current: try c.decodeNil(forKey: .current) ? nil : try value(.current))
        case "cluster_removed": self = .removed(clusterId: id)
        case "cluster_error": self = .error(clusterId: id, message: try value(.message))
        default: throw DecodingError.dataCorruptedError(forKey: .t, in: c, debugDescription: "unknown cluster message \(t)")
        }
    }

    public var clusterId: String {
        switch self {
        case .snapshot(let snapshot): snapshot.id
        case .post(let id, _), .doc(let id, _), .info(let id, _, _), .member(let id, _), .memberLeft(let id, _), .session(let id, _),
            .sessionLeft(let id, _, _), .key(let id, _), .conflict(let id, _, _), .removed(let id), .error(let id, _):
            id
        }
    }
}

// MARK: The cluster's state

public struct ClusterState: Equatable, Sendable {
    public struct Member: Equatable, Sendable {
        public let account: String
        public let role: ClusterRole
        public let joinedAt: String
        public let profile: ClusterMemberProfile?
        /// Its public key, sealed with each version it was published under: what the owner wraps a new key for.
        let publicKeys: [String]
    }

    public struct Session: Equatable, Sendable {
        public let account: String
        public let session: String
        public let machine: String?
        public let joinedAt: String
        public let profile: ClusterSessionProfile?
        public let online: Bool
        public let ready: Bool
        /// As the relay sees it; nil while it has none, or for a status this client does not know.
        public let status: String?
    }

    public struct Post: Equatable, Sendable, Identifiable {
        public let id: String
        public let seq: Int
        public let ts: String
        public let account: String
        public let session: String?
        public let machine: String?
        /// Nil when it does not open with the cluster key or has the wrong shape.
        public let body: ClusterPostBody?
    }

    /// A document as last written, still sealed: open it with `ClusterVault.doc`.
    public struct Doc: Equatable, Sendable {
        public let name: String
        public let rev: Int
        public let updatedAt: String
        public let account: String
        public let session: String?
        public let machine: String?
        public let blob: String
    }

    public let id: String
    public let createdAt: String
    public var keyVersion: Int
    public var info: ClusterInfo?
    public var members: [Member]
    public var sessions: [Session]
    /// The latest ones, oldest first.
    public var posts: [Post]
    public var docs: [Doc]
    /// This member's private key for the cluster and the cluster keys wrapped for it.
    public var own: PoolOwnKeys
}

/// Seals with the latest cluster key it holds and opens with whichever version sealed a blob. What another member sealed
/// is read like anything else untrusted: a blob that does not open, or does not have the expected shape, reads as nil.
public struct ClusterVault: Sendable {
    public let keyring: PoolKeyring

    private static let statuses: Set<String> = ["starting", "working", "waiting", "permission", "idle", "error", "ended", "offline"]

    /// A key alone is version 1 of the cluster key.
    public init(key base64URL: String) throws {
        _ = try E2E.key(fromBase64URL: base64URL)
        keyring = PoolKeyring(key: base64URL)
    }

    public init(keyring: PoolKeyring) {
        self.keyring = keyring
    }

    public func seal<T: Encodable>(_ value: T) throws -> String { try keyring.seal(value) }

    func read<T: ClusterPayload>(_ blob: String?, as type: T.Type) -> T? {
        guard let blob, let json = try? keyring.open(blob, as: ClusterJSON.self) else { return nil }
        return T(json: json)
    }

    public func info(_ blob: String?) -> ClusterInfo? { read(blob, as: ClusterInfo.self) }
    public func post(_ blob: String?) -> ClusterPostBody? { read(blob, as: ClusterPostBody.self) }
    public func notes(_ state: ClusterState) -> ClusterNotes? { read(state.docs.first { $0.name == "notes" }?.blob, as: ClusterNotes.self) }
    public func claims(_ state: ClusterState) -> ClusterClaims? {
        read(state.docs.first { $0.name == "claims" }?.blob, as: ClusterClaims.self)
    }
    public func clock(_ state: ClusterState) -> ClusterClock? { read(state.docs.first { $0.name == "clock" }?.blob, as: ClusterClock.self) }

    public func snapshot(_ cluster: ClusterSnapshot) -> ClusterState {
        ClusterState(
            id: cluster.id, createdAt: cluster.createdAt, keyVersion: cluster.keyVersion, info: info(cluster.info),
            members: cluster.members.map(member), sessions: cluster.sessions.map(session),
            posts: Array(cluster.posts.map(post).suffix(Cluster.keptPosts)), docs: cluster.docs.map(Self.doc),
            own: cluster.own ?? PoolOwnKeys(secret: nil, wraps: []))
    }

    /// The next state, or nil when the cluster is gone for this client. The state passed in is never changed.
    public func apply(_ update: ClusterUpdate, to state: ClusterState) -> ClusterState? {
        if case .snapshot(let cluster) = update { return cluster.id == state.id ? snapshot(cluster) : state }
        guard update.clusterId == state.id else { return state }
        var next = state
        switch update {
        case .snapshot: break
        case .post(_, let wire):
            guard !state.posts.contains(where: { $0.id == wire.id }) else { return state }
            next.posts = Array((state.posts + [post(wire)]).suffix(Cluster.keptPosts))
        case .doc(_, let wire):
            next.docs = state.docs.filter { $0.name != wire.name } + [Self.doc(wire)]
        case .info(_, let blob, let keyVersion):
            next.info = info(blob)
            next.keyVersion = keyVersion
        case .member(_, let wire):
            next.members = state.members.filter { $0.account != wire.account } + [member(wire)]
        case .memberLeft(_, let account):
            next.members = state.members.filter { $0.account != account }
            next.sessions = state.sessions.filter { $0.account != account }
        case .session(_, let wire):
            next.sessions = state.sessions.filter { $0.account != wire.account || $0.session != wire.session } + [session(wire)]
        case .sessionLeft(_, let account, let session):
            next.sessions = state.sessions.filter { $0.account != account || $0.session != session }
        case .key(_, let wrap):
            let wraps = state.own.wraps.filter { $0.version != wrap.version } + [wrap]
            next.own = PoolOwnKeys(secret: state.own.secret, wraps: wraps.sorted { $0.version < $1.version })
        case .removed: return nil
        case .conflict, .error: return state
        }
        return next
    }

    private func member(_ wire: ClusterMemberWire) -> ClusterState.Member {
        ClusterState.Member(
            account: wire.account, role: wire.role, joinedAt: wire.joinedAt, profile: read(wire.profile, as: ClusterMemberProfile.self),
            publicKeys: wire.publicKeys)
    }

    private func session(_ wire: ClusterSessionWire) -> ClusterState.Session {
        ClusterState.Session(
            account: wire.account, session: wire.session, machine: wire.machine, joinedAt: wire.joinedAt,
            profile: read(wire.profile, as: ClusterSessionProfile.self), online: wire.online, ready: wire.ready,
            status: wire.status.flatMap { Self.statuses.contains($0) ? $0 : nil })
    }

    private func post(_ wire: ClusterPostWire) -> ClusterState.Post {
        ClusterState.Post(
            id: wire.id, seq: wire.seq, ts: wire.ts, account: wire.account, session: wire.session, machine: wire.machine,
            body: post(wire.blob))
    }

    private static func doc(_ wire: ClusterDocWire) -> ClusterState.Doc {
        ClusterState.Doc(
            name: wire.name, rev: wire.rev, updatedAt: wire.updatedAt, account: wire.account, session: wire.session, machine: wire.machine,
            blob: wire.blob)
    }
}
