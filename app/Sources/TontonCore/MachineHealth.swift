import Foundation

/// What a machine's background service reports every minute (shared/protocol.ts `MachineHealth`), once decrypted.
public struct MachineHealth: Codable, Equatable, Sendable {
    public struct Battery: Codable, Equatable, Sendable {
        public let percent: Int
        public let charging: Bool
    }

    /// From 0 to 1.
    public let cpu: Double
    public let memoryUsed: Double
    public let memoryTotal: Double
    public let battery: Battery?
    /// Missing from older agents.
    public let wake: [WakeOnLAN.Target]?
    /// The coding agents installed (`claude`, `opencode`). Missing from older agents, which only start claude.
    public var tools: [String]? = nil
    public let at: String

    /// A report older than this means the service stopped sending: it is shown dimmed.
    public static let staleAfter: TimeInterval = 3 * 60

    public func isStale(now: Date = Date()) -> Bool {
        guard let date = ISO8601.parse(at) else { return true }
        return now.timeIntervalSince(date) > Self.staleAfter
    }

    /// e.g. "CPU 23% · memory 11.2 / 16 GB · battery 87% ⚡".
    public var summary: String {
        // The decimal mark of the language, like Money: the English stays as it was.
        let language = Locale(identifier: Strings.locale.language.languageCode?.identifier ?? "en")
        let gigabytes = { (bytes: Double) in
            String(format: bytes >= 10 * 1_073_741_824 ? "%.0f" : "%.1f", locale: language, bytes / 1_073_741_824)
        }
        let cpu = Int((self.cpu * 100).rounded())
        var parts = [String(core: "CPU \(cpu)%"), String(core: "memory \(gigabytes(memoryUsed)) / \(gigabytes(memoryTotal)) GB")]
        if let battery {
            parts.append(battery.charging ? String(core: "battery \(battery.percent)% ⚡") : String(core: "battery \(battery.percent)%"))
        }
        return parts.joined(separator: " · ")
    }
}
