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

    private static let recoveryPrefix = "tonton1."

    public init(relay: String, accountId: String, token: String, key: String) {
        self.relay = relay
        self.accountId = accountId
        self.token = token
        self.key = key
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
