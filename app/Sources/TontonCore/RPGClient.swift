import Foundation

/// Conflicting writes retry against the newest encrypted hero. Failed reads never reset a character.
public struct RPGClient: Sendable {
    private let account: Account
    private let session: URLSession
    public init(account: Account, session: URLSession = .shared) { self.account = account; self.session = session }

    public func read() async throws -> (document: RPGDocument, state: RPG.State) {
        let (data, _) = try await request("GET")
        let document = try JSONDecoder().decode(RPGDocument.self, from: data)
        guard document.rev >= 0, document.rev < 9_007_199_254_740_991, (document.rev == 0) == (document.blob == nil) else {
            throw RPG.Failure.invalidState
        }
        let state: RPG.State
        if let blob = document.blob {
            state = try E2E.open(blob, as: RPG.State.self, with: account.symmetricKey())
        } else {
            state = RPG.State()
        }
        try state.validate()
        return (document, state)
    }

    public func change(_ apply: @Sendable (inout RPG.State) throws -> Void) async throws -> RPG.State {
        for _ in 0..<8 {
            let (document, state) = try await read()
            var next = state
            try apply(&next)
            if next == state { return state }
            try next.validate()
            let body = try JSONEncoder().encode(RPGDocument(rev: document.rev, blob: E2E.seal(next, with: account.symmetricKey())))
            let (_, status) = try await request("PUT", body: body)
            if status == 409 { continue }
            return next
        }
        throw RPG.Failure.conflict
    }

    private func request(_ method: String, body: Data? = nil) async throws -> (Data, Int) {
        guard let url = URL(string: account.relay + "/api/rpg") else { throw RPG.Failure.invalidState }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        request.httpMethod = method
        request.httpBody = body
        request.setValue("Bearer \(account.token)", forHTTPHeaderField: "Authorization")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) || (method == "PUT" && status == 409) else {
            throw RelayError(message: String(core: "Could not sync Tonton."), status: status)
        }
        return (data, status)
    }
}
