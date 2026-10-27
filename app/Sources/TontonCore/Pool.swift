import CryptoKit
import Foundation

// Pools (docs/pools.md): several accounts whose sessions build one project together. Mirrors shared/pool-protocol.ts,
// shared/pool.ts and shared/pool-link.ts. What the relay keeps in clear is ids, roles, revisions and times; the rest is
// sealed with the pool key, which the members share and the relay never gets.

public enum PoolRole: String, Codable, Sendable {
    case owner, admin, member, viewer
}

// MARK: Invites

/// An invite to a pool, as a link or a QR code: `tontonpool1.` and base64url JSON of the relay, the pool, the invite
/// token and the pool key.
public struct PoolInvite: Equatable, Sendable {
    public let relay: String
    public let pool: String
    /// `tp_…`: joins the pool, nothing else.
    public let token: String
    /// Base64url AES-256 pool key.
    public let key: String
    public let version: Int

    private static let prefix = "tontonpool1."
    private struct Payload: Codable {
        let relay: String
        let pool: String
        let token: String
        let key: String
        let v: Int
    }

    public init(relay: String, pool: String, token: String, key: String, version: Int) {
        (self.relay, self.pool, self.token, self.key, self.version) = (relay, pool, token, key, version)
    }

    public init?(string: String) {
        var trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("#") { trimmed.removeFirst() }
        guard trimmed.hasPrefix(Self.prefix), let data = Data(base64URLEncoded: String(trimmed.dropFirst(Self.prefix.count))),
            let payload = try? JSONDecoder().decode(Payload.self, from: data),
            let relay = URL(string: payload.relay), ["https", "http"].contains(relay.scheme ?? ""),
            payload.pool.wholeMatch(of: #/[A-Za-z0-9_-]{12}/#) != nil,
            payload.token.wholeMatch(of: #/tp_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}/#) != nil,
            (try? E2E.key(fromBase64URL: payload.key)) != nil, payload.v >= 1
        else { return nil }
        self.init(
            relay: RelayAPI.normalize(payload.relay), pool: payload.pool, token: payload.token, key: payload.key, version: payload.v)
    }

    /// What the member who invites hands out.
    public var string: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let payload = Payload(relay: relay, pool: pool, token: token, key: key, v: version)
        return Self.prefix + ((try? encoder.encode(payload)) ?? Data()).base64URLEncodedString()
    }
}

// MARK: Sealed with the account key

/// A member's own copy of the pool key, kept on the relay so its other devices and its machines' agents get it.
struct PoolKeyGrant: Codable, Equatable {
    let poolId: String
    let key: String
    let version: Int
}

/// From the member's app to one of its sessions' agents: work for this pool, with its key.
struct PoolSessionOrder: Codable, Equatable {
    let poolId: String
    let sessionId: String
    let key: String
    let version: Int
    let issuedAt: String
}

extension SessionVault {
    /// The member's copy of the pool key, for the relay to keep.
    public func sealPoolKeyGrant(poolId: String, key poolKey: String, version: Int) throws -> String {
        try E2E.seal(PoolKeyGrant(poolId: poolId, key: poolKey, version: version), with: key)
    }

    /// The pool key from the member's copy, if it opens with the account key and is for this pool.
    public func poolKey(from grant: String, poolId: String) -> (key: String, version: Int)? {
        guard let opened = try? E2E.open(grant, as: PoolKeyGrant.self, with: key), opened.poolId == poolId,
            (try? E2E.key(fromBase64URL: opened.key)) != nil, opened.version >= 1
        else { return nil }
        return (opened.key, opened.version)
    }

    /// Puts one of the account's sessions in a pool: its agent takes it only if it opens with the account key and names
    /// that session.
    public func sealPoolSessionOrder(
        poolId: String, sessionId: String, key poolKey: String, version: Int, issuedAt: Date = Date()
    )
        throws -> String
    {
        let order = PoolSessionOrder(
            poolId: poolId, sessionId: sessionId, key: poolKey, version: version, issuedAt: ISO8601DateFormatter().string(from: issuedAt))
        return try E2E.seal(order, with: key)
    }
}

// MARK: Sealed with the pool key

public struct PoolInfo: Codable, Equatable, Sendable {
    public var name: String
    public var goal: String?

    public init(name: String, goal: String? = nil) {
        self.name = name
        self.goal = goal
    }
}

public struct PoolMemberProfile: Codable, Equatable, Sendable {
    public var name: String

    public init(name: String) { self.name = name }
}

public struct PoolSessionProfile: Codable, Equatable, Sendable {
    /// `front`, `back`, `infra`, `tests`, `docs`, `review`, or anything else.
    public var area: String?
    public var skills: String?
    public var repo: String?
    public var project: String?
    public var machine: String?
    /// `claude` or `opencode`.
    public var tool: String?
    public var orchestrator: Bool?

    public init(
        area: String? = nil, skills: String? = nil, repo: String? = nil, project: String? = nil, machine: String? = nil,
        tool: String? = nil, orchestrator: Bool? = nil
    ) {
        (self.area, self.skills, self.repo, self.project, self.machine, self.tool, self.orchestrator) = (
            area, skills, repo, project, machine, tool, orchestrator
        )
    }
}

public enum PoolTaskState: String, Codable, Sendable {
    case todo, assigned, inProgress = "in_progress", review, done, blocked
}

public struct PoolSessionRef: Codable, Equatable, Sendable {
    public let account: String
    public let session: String
}

public struct PoolTask: Codable, Equatable, Sendable {
    public var title: String
    public var goal: String?
    public var criteria: [String]?
    public var area: String?
    public var state: PoolTaskState
    public var assignee: PoolSessionRef?
    public var dependsOn: [String]?
    public var branch: String?
    public var summary: String?
}

public struct PoolNotes: Codable, Equatable, Sendable {
    public var text: String
}

public struct PoolMessageBody: Codable, Equatable, Sendable {
    public struct Target: Codable, Equatable, Sendable {
        public var session: PoolSessionRef?
        public var area: String?
    }
    public var text: String
    /// Nil: everyone.
    public var to: Target?
}

public struct PoolEventBody: Codable, Equatable, Sendable {
    public var kind: String
    public var text: String?
    public var taskId: String?
}

/// Seals with the latest pool key it holds and opens with whichever version sealed a blob. What another member sealed
/// is read like anything else untrusted: a blob that does not open, or does not have the expected shape, reads as nil.
public struct PoolVault: Sendable {
    public let keyring: PoolKeyring

    /// A key alone is version 1 of the pool key.
    public init(key base64URL: String) throws {
        _ = try E2E.key(fromBase64URL: base64URL)
        keyring = PoolKeyring(key: base64URL)
    }

    public init(keyring: PoolKeyring) {
        self.keyring = keyring
    }

    public func seal<T: Encodable>(_ value: T) throws -> String { try keyring.seal(value) }

    public func open<T: Decodable>(_ blob: String?, as type: T.Type) -> T? {
        guard let blob else { return nil }
        return try? keyring.open(blob, as: type)
    }
}

// MARK: What the relay sends

/// A pool as `GET /api/pools` lists it for the account asking.
public struct PoolSummary: Codable, Equatable, Sendable {
    public let id: String
    public let role: PoolRole
    public let createdAt: String
    public let paused: Bool
    public let keyVersion: Int
    /// `PoolInfo`, sealed with the pool key.
    public let info: String
    /// `PoolKeyGrant`, sealed with the account key: the version this member joined with.
    public let key: String
    public let members: Int
    /// `PoolMemberSecret`, sealed with the account key.
    public let secret: String?
    /// Later versions of the pool key, wrapped for this member.
    public let wraps: [PoolKeyWrapWire]

    private enum Keys: String, CodingKey { case id, role, createdAt, paused, keyVersion, info, key, members, secret, wraps }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        (id, role, createdAt) = (
            try c.decode(String.self, forKey: .id), try c.decode(PoolRole.self, forKey: .role),
            try c.decode(String.self, forKey: .createdAt)
        )
        (paused, keyVersion, info) = (
            try c.decode(Bool.self, forKey: .paused), try c.decode(Int.self, forKey: .keyVersion), try c.decode(String.self, forKey: .info)
        )
        (key, members) = (try c.decode(String.self, forKey: .key), try c.decode(Int.self, forKey: .members))
        secret = try c.decodeIfPresent(String.self, forKey: .secret)
        wraps = try c.decodeIfPresent([PoolKeyWrapWire].self, forKey: .wraps) ?? []
    }
}

public struct PoolMemberWire: Codable, Equatable, Sendable {
    public let account: String
    public let role: PoolRole
    public let joinedAt: String
    public let profile: String?
    /// `PoolMemberKey`, sealed with each version of the pool key it was published under.
    public let publicKeys: [String]

    public init(account: String, role: PoolRole, joinedAt: String, profile: String?, publicKeys: [String] = []) {
        (self.account, self.role, self.joinedAt, self.profile, self.publicKeys) = (account, role, joinedAt, profile, publicKeys)
    }

    private enum Keys: String, CodingKey { case account, role, joinedAt, profile, publicKeys }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        account = try c.decode(String.self, forKey: .account)
        role = try c.decode(PoolRole.self, forKey: .role)
        joinedAt = try c.decode(String.self, forKey: .joinedAt)
        profile = try c.decodeIfPresent(String.self, forKey: .profile)
        publicKeys = try c.decodeIfPresent([String].self, forKey: .publicKeys) ?? []
    }
}

public struct PoolSessionWire: Codable, Equatable, Sendable {
    public let account: String
    public let session: String
    public let joinedAt: String
    public let profile: String?
    public let online: Bool
    public let ready: Bool
}

/// A task, the notes, a message or an event: who wrote it, when, and the sealed blob.
public struct PoolItemWire: Codable, Equatable, Sendable {
    /// Missing for the notes.
    public let id: String?
    /// Tasks and notes.
    public let rev: Int?
    /// Messages and events.
    public let seq: Int?
    public let updatedAt: String?
    public let ts: String?
    public let account: String
    public let session: String?
    public let blob: String
}

public struct PoolSnapshot: Codable, Equatable, Sendable {
    public let id: String
    public let createdAt: String
    public let paused: Bool
    public let keyVersion: Int
    public let info: String
    public let members: [PoolMemberWire]
    public let sessions: [PoolSessionWire]
    public let tasks: [PoolItemWire]
    public let notes: PoolItemWire?
    public let messages: [PoolItemWire]
    public let events: [PoolItemWire]
    /// For the account it was sent to: its private key and the pool keys wrapped for it.
    public let own: PoolOwnKeys?
}

/// The pool messages of the relay, on the app's socket (`RelayMessage.pool`).
public enum PoolUpdate: Decodable, Equatable, Sendable {
    case snapshot(PoolSnapshot)
    case task(poolId: String, PoolItemWire)
    case notes(poolId: String, PoolItemWire)
    case message(poolId: String, PoolItemWire)
    case event(poolId: String, PoolItemWire)
    case info(poolId: String, info: String, paused: Bool, keyVersion: Int)
    case member(poolId: String, PoolMemberWire)
    case memberLeft(poolId: String, account: String)
    case session(poolId: String, PoolSessionWire)
    case sessionLeft(poolId: String, account: String, session: String)
    /// To one member: the pool key was rotated, here is the new version wrapped for it.
    case key(poolId: String, PoolKeyWrapWire)
    /// A change sent over an older revision was refused: the current one, if any.
    case conflict(poolId: String, kind: String, id: String?, current: PoolItemWire?)
    case removed(poolId: String)
    case error(poolId: String, message: String)

    private enum Keys: String, CodingKey {
        case t, pool, poolId, task, notes, message, event, info, paused, keyVersion, member, account, session, kind, id, current, wrap
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        func value<T: Decodable>(_ key: Keys) throws -> T { try container.decode(T.self, forKey: key) }
        let t: String = try value(.t)
        if t == "pool_snapshot" {
            self = .snapshot(try value(.pool))
            return
        }
        let poolId: String = try value(.poolId)
        switch t {
        case "pool_task": self = .task(poolId: poolId, try value(.task))
        case "pool_notes": self = .notes(poolId: poolId, try value(.notes))
        case "pool_message": self = .message(poolId: poolId, try value(.message))
        case "pool_event": self = .event(poolId: poolId, try value(.event))
        case "pool_info":
            self = .info(poolId: poolId, info: try value(.info), paused: try value(.paused), keyVersion: try value(.keyVersion))
        case "pool_member": self = .member(poolId: poolId, try value(.member))
        case "pool_member_left": self = .memberLeft(poolId: poolId, account: try value(.account))
        case "pool_session": self = .session(poolId: poolId, try value(.session))
        case "pool_session_left":
            self = .sessionLeft(poolId: poolId, account: try value(.account), session: try container.decode(String.self, forKey: .session))
        case "pool_conflict":
            self = .conflict(
                poolId: poolId, kind: try value(.kind), id: try container.decodeIfPresent(String.self, forKey: .id),
                current: try container.decodeIfPresent(PoolItemWire.self, forKey: .current))
        case "pool_key": self = .key(poolId: poolId, try value(.wrap))
        case "pool_removed": self = .removed(poolId: poolId)
        case "pool_error": self = .error(poolId: poolId, message: try value(.message))
        default: throw DecodingError.dataCorruptedError(forKey: .t, in: container, debugDescription: "unknown pool message \(t)")
        }
    }
}
