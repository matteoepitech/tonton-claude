import Foundation

public struct RelayError: LocalizedError, Equatable {
    public let message: String
    /// The HTTP status, when the relay answered.
    public let status: Int?
    public var errorDescription: String? { message }

    public init(message: String, status: Int? = nil) {
        self.message = message
        self.status = status
    }
}

/// HTTP calls to a relay. Stateless: the account (or the relay URL, before an account exists) is passed in.
public struct RelayAPI: Sendable {
    private let session: URLSession

    public init(session: URLSession = URLSession(configuration: .ephemeral)) {
        self.session = session
    }

    /// Creates an account. The end-to-end key is generated here and is never sent.
    public func createAccount(on relay: String) async throws -> Account {
        struct Created: Decodable { let accountId: String; let token: String }
        let base = Self.normalize(relay)
        let created = try await request("POST", base, "/api/accounts", token: nil, as: Created.self)
        return Account(relay: base, accountId: created.accountId, token: created.token, key: E2E.newKey())
    }

    /// Checks that an account (typically restored from a recovery key) is still valid on its relay.
    public func verify(_ account: Account) async throws {
        struct Ping: Decodable { let ok: Bool }
        _ = try await request("GET", account.relay, "/api/ping", token: account.token, as: Ping.self)
    }

    /// The join secret of the account token. `regenerate` replaces the current one and signs every machine out.
    public func joinSecret(for account: Account, regenerate: Bool) async throws -> String {
        struct Secret: Decodable { let secret: String }
        let body = try JSONEncoder().encode(["regenerate": regenerate])
        return try await request("POST", account.relay, "/api/account/token", token: account.token, body: body, as: Secret.self).secret
    }

    public func revokeMachine(_ machineId: String, of account: Account) async throws {
        struct Done: Decodable { let ok: Bool }
        _ = try await request("DELETE", account.relay, "/api/machines/\(machineId)", token: account.token, as: Done.self)
    }

    /// A read-only share of one session, for `hours`: its id, its token for the teammate, and when it ends.
    public func createShare(
        of sessionId: String, hours: Int, for account: Account
    ) async throws -> (
        id: String, token: String, expiresAt: String
    ) {
        struct Created: Decodable { let id: String; let token: String; let expiresAt: String }
        struct Body: Encodable { let sessionId: String; let hours: Int }
        let body = try JSONEncoder().encode(Body(sessionId: sessionId, hours: hours))
        let created = try await request("POST", account.relay, "/api/shares", token: account.token, body: body, as: Created.self)
        return (created.id, created.token, created.expiresAt)
    }

    public func shares(of account: Account) async throws -> [ShareSummary] {
        try await request("GET", account.relay, "/api/shares", token: account.token, as: [ShareSummary].self)
    }

    /// The account's pools, with its role and its keys for each. Relays before pools answer "not found".
    public func pools(of account: Account) async throws -> [PoolSummary] {
        try await request("GET", account.relay, "/api/pools", token: account.token, as: [PoolSummary].self)
    }

    public func revokeShare(_ shareId: String, of account: Account) async throws {
        struct Done: Decodable { let ok: Bool }
        _ = try await request("DELETE", account.relay, "/api/shares/\(shareId)", token: account.token, as: Done.self)
    }

    public func deleteAccount(_ account: Account) async throws {
        struct Done: Decodable { let ok: Bool }
        _ = try await request("DELETE", account.relay, "/api/account", token: account.token, as: Done.self)
    }

    /// Saves what an iPhone wants pushed, and says whether the relay pushes at all. Nil from relays older than pushes.
    public func register(_ device: PushDevice, for account: Account) async throws -> Bool? {
        struct Status: Decodable { let enabled: Bool }
        let body = try JSONEncoder().encode(device)
        do {
            return try await request("POST", account.relay, "/api/push/devices", token: account.token, body: body, as: Status.self).enabled
        } catch let error as RelayError where error.status == 404 {
            return nil
        }
    }

    /// The phone signs out: the relay forgets its tokens.
    public func unregister(device: String, for account: Account) async throws {
        struct Done: Decodable { let ok: Bool }
        _ = try await request("DELETE", account.relay, "/api/push/devices/\(device)", token: account.token, as: Done.self)
    }

    public static func normalize(_ relay: String) -> String {
        relay.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    private func request<T: Decodable>(
        _ method: String, _ base: String, _ path: String, token: String?, body: Data? = nil, as type: T.Type
    ) async throws -> T {
        guard let url = URL(string: base + path) else { throw RelayError(message: String(core: "Invalid relay URL.")) }
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = method
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let message = (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? "HTTP \(status)"
            throw RelayError(message: message, status: status)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
