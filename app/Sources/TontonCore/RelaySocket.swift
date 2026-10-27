import Foundation

public enum ConnectionState: Equatable, Sendable {
    case notConfigured, paused, connecting, connected, failed(String)
}

/// The app's WebSocket to its relay: connects with the account token, reconnects with backoff, and decodes messages.
/// Callbacks run on the main actor.
@MainActor
public final class RelaySocket {
    public var onState: (ConnectionState) -> Void = { _ in }
    public var onMessage: (RelayMessage) -> Void = { _ in }
    /// A new round-trip measure, or nil when disconnected.
    public var onLatency: (RelayLatency?) -> Void = { _ in }

    private let session = URLSession(configuration: .ephemeral)
    private var task: URLSessionWebSocketTask?
    private var generation = 0
    private var backoff: TimeInterval = 1
    private var pingTimer: Timer?
    private var account: Account?
    /// The iPhone app's install id: the relay leaves its Live Activity to it while this socket is open.
    private var device: String?
    private(set) public var state: ConnectionState = .notConfigured {
        didSet { if state != oldValue { onState(state) } }
    }

    public init() {}

    public func connect(_ account: Account, device: String? = nil) {
        disconnect(to: .connecting)
        self.account = account
        self.device = device
        open()
    }

    public func disconnect(to state: ConnectionState = .paused) {
        generation += 1
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        pingTimer?.invalidate()
        pingTimer = nil
        backoff = 1
        self.state = state
        onLatency(nil)
    }

    public func send(_ object: [String: Any]) {
        guard let task, let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8)
        else { return }
        task.send(.string(text)) { _ in }
    }

    private func open() {
        guard let account, var components = URLComponents(string: account.relay) else {
            state = .notConfigured
            return
        }
        components.scheme = components.scheme == "http" ? "ws" : "wss"
        components.path += "/ws/app"
        guard let url = components.url else {
            state = .failed("Invalid relay URL")
            return
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(account.token)", forHTTPHeaderField: "Authorization")
        if let device { request.setValue(device, forHTTPHeaderField: "X-Tonton-Device") }

        generation += 1
        let current = generation
        let task = session.webSocketTask(with: request)
        task.maximumMessageSize = 64 * 1024 * 1024
        self.task = task
        state = .connecting
        task.resume()
        receive(task, generation: current)
        pingTimer?.invalidate()
        // The pings keep the connection open and time the round trip.
        pingTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self, weak task] _ in
            Task { @MainActor in if let task { self?.ping(task, generation: current) } }
        }
    }

    private func ping(_ task: URLSessionWebSocketTask, generation current: Int) {
        let start = ContinuousClock.now
        task.sendPing { [weak self] error in
            let elapsed = start.duration(to: .now)
            Task { @MainActor in
                guard let self, error == nil, current == self.generation else { return }
                let region = (task.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "x-tonton-region")
                let milliseconds = Int((Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18) * 1000)
                self.onLatency(RelayLatency(milliseconds: milliseconds, region: region))
            }
        }
    }

    private func receive(_ task: URLSessionWebSocketTask, generation current: Int) {
        task.receive { [weak self] result in
            // A history can be megabytes of JSON: it is decoded here, off the main actor. The next message is only asked
            // for once this one was handled, so they stay in order.
            let decoded = (try? result.get()).flatMap(Self.decode)
            Task { @MainActor in
                guard let self, current == self.generation else { return }
                switch result {
                case .success:
                    self.backoff = 1
                    // The first message tells the connection is up: time it right away rather than in 20 seconds.
                    if self.state != .connected { self.ping(task, generation: current) }
                    self.state = .connected
                    if let decoded { self.onMessage(decoded) }
                    self.receive(task, generation: current)
                case .failure(let error):
                    let unauthorized = (task.response as? HTTPURLResponse)?.statusCode == 401
                    self.state = .failed(unauthorized ? "Account rejected by the relay" : error.localizedDescription)
                    self.scheduleReconnect(generation: current)
                }
            }
        }
    }

    private func scheduleReconnect(generation current: Int) {
        let delay = backoff
        backoff = min(backoff * 2, 30)
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, current == self.generation else { return }
            self.open()
        }
    }

    nonisolated private static func decode(_ message: URLSessionWebSocketTask.Message) -> RelayMessage? {
        let data: Data
        switch message {
        case .string(let text): data = Data(text.utf8)
        case .data(let bytes): data = bytes
        @unknown default: return nil
        }
        return try? JSONDecoder().decode(RelayMessage.self, from: data)
    }
}
