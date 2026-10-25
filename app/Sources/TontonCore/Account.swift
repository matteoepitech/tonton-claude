import CryptoKit
import Foundation

/// An account on a relay. The token authenticates the app; the key encrypts everything end to end and never leaves
/// the user's devices.
public struct Account: Codable, Equatable, Sendable {
    public let relay: String
    public let accountId: String
    /// `ta_…`, sent to the relay as a bearer token.
    public let token: String
    /// Base64url AES-256 key.
    public let key: String
    /// Lets machines join the account, through the account token. Missing until the app asks the relay for one.
    public let joinSecret: String?

    private static let recoveryPrefix = "tonton1."

    public init(relay: String, accountId: String, token: String, key: String, joinSecret: String? = nil) {
        self.relay = relay
        self.accountId = accountId
        self.token = token
        self.key = key
        self.joinSecret = joinSecret
    }

    /// The token machines join the account with, like a RustDesk server key: `tonton_` and base64url JSON holding the
    /// relay, the account, the join secret and the end-to-end key. Mirrors shared/account-token.ts.
    public var machineToken: String? {
        struct Payload: Encodable { let relay: String; let account: String; let secret: String; let key: String }
        guard let joinSecret,
            let json = try? JSONEncoder().encode(Payload(relay: relay, account: accountId, secret: joinSecret, key: key))
        else { return nil }
        return "tonton_" + json.base64URLEncodedString()
    }

    public func with(key: String? = nil, joinSecret: String?) -> Account {
        Account(relay: relay, accountId: accountId, token: token, key: key ?? self.key, joinSecret: joinSecret)
    }

    /// Restores an account from its recovery key; nil if the string is not one.
    public init?(recoveryKey: String) {
        let trimmed = recoveryKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix(Self.recoveryPrefix),
            let data = Data(base64URLEncoded: String(trimmed.dropFirst(Self.recoveryPrefix.count))),
            let account = try? JSONDecoder().decode(Account.self, from: data),
            (try? E2E.key(fromBase64URL: account.key)) != nil
        else { return nil }
        self = account
    }

    /// Everything needed to sign in on another Mac. Whoever holds it can read and drive the sessions.
    public var recoveryKey: String {
        let json = (try? JSONEncoder().encode(self)) ?? Data()
        return Self.recoveryPrefix + json.base64URLEncodedString()
    }

    public func symmetricKey() throws -> SymmetricKey {
        try E2E.key(fromBase64URL: key)
    }
}
