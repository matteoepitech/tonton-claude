/// The round trip to the relay, measured with WebSocket pings, and how it feels from the notch.
public struct RelayLatency: Equatable, Sendable {
    public enum Level: Sendable { case good, fair, high }

    /// Milliseconds.
    public let milliseconds: Int
    /// Where the relay says it runs, when it says.
    public let region: String?

    public init(milliseconds: Int, region: String?) {
        self.milliseconds = milliseconds
        self.region = region
    }

    /// Past 400 ms, approvals and replies feel slow.
    public var level: Level { milliseconds < 150 ? .good : milliseconds < 400 ? .fair : .high }

    public var label: String {
        [region, milliseconds < 1 ? String(core: "<1 ms") : String(core: "\(milliseconds) ms")].compactMap { $0 }.joined(separator: " · ")
    }
}
