import Foundation

public struct RelayError: LocalizedError, Equatable {
    public let message: String
    public var errorDescription: String? { message }

    public init(message: String) {
        self.message = message
    }
}

public struct Enrollment: Decodable, Equatable, Sendable {
    public let code: String
    public let expiresAt: String
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

    public func newEnrollment(for account: Account) async throws -> Enrollment {
        try await request("POST", account.relay, "/api/enrollments", token: account.token, as: Enrollment.self)
    }

    public func revokeMachine(_ machineId: String, of account: Account) async throws {
        struct Done: Decodable { let ok: Bool }
        _ = try await request("DELETE", account.relay, "/api/machines/\(machineId)", token: account.token, as: Done.self)
    }

    public func deleteAccount(_ account: Account) async throws {
        struct Done: Decodable { let ok: Bool }
        _ = try await request("DELETE", account.relay, "/api/account", token: account.token, as: Done.self)
    }

    public static func normalize(_ relay: String) -> String {
        relay.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    private func request<T: Decodable>(_ method: String, _ base: String, _ path: String, token: String?, as type: T.Type) async throws -> T
    {
        guard let url = URL(string: base + path) else { throw RelayError(message: "Invalid relay URL.") }
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = method
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let message = (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? "HTTP \(status)"
            throw RelayError(message: message)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
