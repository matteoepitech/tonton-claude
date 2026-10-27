import CryptoKit
import Foundation

// The keys of a pool over time (docs/pools.md, Keys). Mirrors shared/pool-keys.ts: each member's P-256 key pair, its
// public key sealed with the pool key, its private key sealed with its account key, and each later version of the pool
// key wrapped for it with ECDH between the admin's private key and its public key, then HKDF-SHA256 and AES-256-GCM.
// Blobs sealed with version 2 or later start with `2:`; version 1 has no prefix.

/// Every version of a pool key this client holds, the latest one sealing.
public struct PoolKeyring: Sendable {
    private(set) var keys: [Int: String] = [:]

    public init() {}

    /// A key alone is the version it came with.
    public init(key: String, version: Int = 1) {
        add(version: version, key: key)
    }

    public mutating func add(version: Int, key: String) {
        guard version >= 1, (try? E2E.key(fromBase64URL: key)) != nil else { return }
        keys[version] = key
    }

    public func key(_ version: Int) -> String? { keys[version] }

    /// The latest version held, 0 when none.
    public var version: Int { keys.keys.max() ?? 0 }

    public var versions: [Int] { keys.keys.sorted() }

    public func seal<T: Encodable>(_ value: T) throws -> String {
        guard let base64URL = key(version) else { throw E2E.Failure.invalidBlob }
        let sealed = try E2E.seal(value, with: try E2E.key(fromBase64URL: base64URL))
        return version == 1 ? sealed : "\(version):\(sealed)"
    }

    public func open<T: Decodable>(_ blob: String, as type: T.Type) throws -> T {
        let (version, sealed) = Self.split(blob)
        guard let base64URL = key(version) else { throw E2E.Failure.invalidBlob }
        return try E2E.open(sealed, as: type, with: try E2E.key(fromBase64URL: base64URL))
    }

    /// The version that sealed a blob, and the blob without it.
    static func split(_ blob: String) -> (Int, String) {
        guard let match = blob.firstMatch(of: #/^(\d{1,6}):/#), let version = Int(match.1) else { return (1, blob) }
        return (version, String(blob[match.range.upperBound...]))
    }

    public static func version(of blob: String) -> Int { split(blob).0 }
}

/// A member's private key for one pool, as JWK coordinates in base64url, like the web's.
struct PoolMemberSecret: Codable, Equatable {
    let poolId: String
    let d: String
    let x: String
    let y: String

    init(poolId: String, privateKey: P256.KeyAgreement.PrivateKey) {
        let point = privateKey.publicKey.x963Representation
        self.poolId = poolId
        d = privateKey.rawRepresentation.base64URLEncodedString()
        x = point.subdata(in: 1..<33).base64URLEncodedString()
        y = point.subdata(in: 33..<65).base64URLEncodedString()
    }

    func privateKey() throws -> P256.KeyAgreement.PrivateKey {
        guard let raw = Data(base64URLEncoded: d) else { throw E2E.Failure.invalidBlob }
        return try P256.KeyAgreement.PrivateKey(rawRepresentation: raw)
    }

    /// The uncompressed public point, base64url.
    var publicKey: String {
        var point = Data([4])
        point.append(Data(base64URLEncoded: x) ?? Data())
        point.append(Data(base64URLEncoded: y) ?? Data())
        return point.base64URLEncodedString()
    }
}

/// A member's public key, bound to its account so it cannot be moved to another.
struct PoolMemberKey: Codable, Equatable {
    let poolId: String
    let account: String
    let key: String
}

/// What a wrap holds: one version of the pool key, for one member, from one admin.
struct PoolKeyWrap: Codable, Equatable {
    let poolId: String
    let version: Int
    let key: String
    let from: String
    let to: String
}

/// A wrap as the relay keeps it for its member.
public struct PoolKeyWrapWire: Codable, Equatable, Sendable {
    public let version: Int
    public let from: String
    public let blob: String
}

/// The member's own keys in a snapshot.
public struct PoolOwnKeys: Codable, Equatable, Sendable {
    public let secret: String?
    public let wraps: [PoolKeyWrapWire]
}

enum PoolKeys {
    static let salt = Data("tonton/pool".utf8)

    /// The AES key between two members for one version of one pool, as shared/pool-keys.ts derives it.
    static func wrapKey(
        _ secret: PoolMemberSecret, peerPublic: String, poolId: String, version: Int, from: String, to: String
    ) throws -> SymmetricKey {
        guard let point = Data(base64URLEncoded: peerPublic) else { throw E2E.Failure.invalidBlob }
        let peer = try P256.KeyAgreement.PublicKey(x963Representation: point)
        let shared = try secret.privateKey().sharedSecretFromKeyAgreement(with: peer)
        let info = Data("tonton/pool-key/v1|\(poolId)|\(version)|\(from)|\(to)".utf8)
        return shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt, sharedInfo: info, outputByteCount: 32)
    }

    static func wrap(_ wrap: PoolKeyWrap, admin: PoolMemberSecret, memberPublic: String) throws -> String {
        let key = try wrapKey(admin, peerPublic: memberPublic, poolId: wrap.poolId, version: wrap.version, from: wrap.from, to: wrap.to)
        return try E2E.seal(wrap, with: key)
    }

    /// The pool key a wrap holds, if it opens and says what was expected.
    static func unwrap(
        _ blob: String, member: PoolMemberSecret, adminPublic: String, poolId: String, version: Int, from: String, to: String
    ) -> String? {
        guard let key = try? wrapKey(member, peerPublic: adminPublic, poolId: poolId, version: version, from: from, to: to),
            let wrap = try? E2E.open(blob, as: PoolKeyWrap.self, with: key),
            wrap.poolId == poolId, wrap.version == version, wrap.from == from, wrap.to == to,
            (try? E2E.key(fromBase64URL: wrap.key)) != nil
        else { return nil }
        return wrap.key
    }

    /// The public key in the first of a member's blobs that opens with the keyring and names that member.
    static func publicKey(in blobs: [String], keyring: PoolKeyring, poolId: String, account: String) -> String? {
        for blob in blobs {
            if let key = try? keyring.open(blob, as: PoolMemberKey.self), key.poolId == poolId, key.account == account,
                Data(base64URLEncoded: key.key)?.count == 65
            {
                return key.key
            }
        }
        return nil
    }

    /// Every version the member can open: the one it joined with, then each wrap in turn, as shared/pool-keys.ts does.
    static func resolve(
        joined: PoolKeyring, secret: PoolMemberSecret?, wraps: [PoolKeyWrapWire], members: [PoolMemberWire], poolId: String,
        account: String
    ) -> PoolKeyring {
        var keyring = joined
        guard let secret else { return keyring }
        var pending = wraps.filter { keyring.key($0.version) == nil }.sorted { $0.version < $1.version }
        var progress = true
        while !pending.isEmpty && progress {
            progress = false
            for wrap in pending {
                guard let admin = members.first(where: { $0.account == wrap.from }),
                    let adminPublic = publicKey(in: admin.publicKeys, keyring: keyring, poolId: poolId, account: wrap.from)
                else { continue }
                pending.removeAll { $0 == wrap }
                if let key = unwrap(
                    wrap.blob, member: secret, adminPublic: adminPublic, poolId: poolId, version: wrap.version, from: wrap.from,
                    to: account)
                {
                    keyring.add(version: wrap.version, key: key)
                    progress = true
                }
            }
        }
        return keyring
    }
}

extension SessionVault {
    /// A new key pair for this member of a pool: its private key sealed with the account key, its public key with the pool key.
    public func newPoolMemberKeys(poolId: String, account: String, keyring: PoolKeyring) throws -> (secret: String, publicKey: String) {
        let secret = PoolMemberSecret(poolId: poolId, privateKey: P256.KeyAgreement.PrivateKey())
        return (try E2E.seal(secret, with: key), try keyring.seal(PoolMemberKey(poolId: poolId, account: account, key: secret.publicKey)))
    }

    func poolMemberSecret(_ sealed: String?, poolId: String) -> PoolMemberSecret? {
        guard let sealed, let secret = try? E2E.open(sealed, as: PoolMemberSecret.self, with: key), secret.poolId == poolId,
            (try? secret.privateKey()) != nil
        else { return nil }
        return secret
    }

    /// Every version of the pool key this member holds, from its grant, its private key and the wraps made for it.
    public func poolKeyring(
        grant: String, own: PoolOwnKeys?, members: [PoolMemberWire], poolId: String, account: String
    ) -> PoolKeyring? {
        guard let joined = poolKey(from: grant, poolId: poolId) else { return nil }
        return PoolKeys.resolve(
            joined: PoolKeyring(key: joined.key, version: joined.version), secret: poolMemberSecret(own?.secret, poolId: poolId),
            wraps: own?.wraps ?? [], members: members, poolId: poolId, account: account)
    }
}
