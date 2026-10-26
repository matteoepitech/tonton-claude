import Foundation

/// A read-only share of one session, for a teammate. Its key is its own: the agent seals a copy of the conversation with
/// it, so whoever holds the share reads that session and nothing else, and the account key never leaves this Mac.
/// Mirrors shared/share-link.ts.
public struct ShareLink: Codable, Equatable, Sendable {
    public let relay: String
    /// `ts_…`: opens the share's socket on the relay, nothing else.
    public let token: String
    /// Base64url AES-256 key of the share.
    public let key: String

    private static let prefix = "tontonshare1."

    public init(relay: String, token: String, key: String) {
        self.relay = relay
        self.token = token
        self.key = key
    }

    public init?(string: String) {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix(Self.prefix),
            let data = Data(base64URLEncoded: String(trimmed.dropFirst(Self.prefix.count))),
            let link = try? JSONDecoder().decode(ShareLink.self, from: data),
            (try? E2E.key(fromBase64URL: link.key)) != nil
        else { return nil }
        self = link
    }

    /// What the teammate pastes in the web app.
    public var string: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return Self.prefix + ((try? encoder.encode(self)) ?? Data()).base64URLEncodedString()
    }
}

/// A share as the relay lists it: never its token nor its key.
public struct ShareSummary: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let sessionId: String
    public let createdAt: String
    public let expiresAt: String
    /// Browsers watching it right now.
    public let viewers: Int

    public var expires: Date? { ISO8601.parse(expiresAt) }
}

/// For how long a share can be made, as the menu offers it. The relay takes up to 30 days.
public enum ShareDuration: Int, CaseIterable, Identifiable, Sendable {
    case hour = 1
    case day = 24
    case week = 168

    public var id: Int { rawValue }
    public var hours: Int { rawValue }
    public var label: String {
        switch self {
        case .hour: "1 hour"
        case .day: "1 day"
        case .week: "1 week"
        }
    }
}

struct ShareOrder: Codable {
    let shareId: String
    let sessionId: String
    let key: String
    let expiresAt: String
}
