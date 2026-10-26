import Foundation

/// The background tasks of a Claude Code session that have not reported back: shells run in the background, monitors,
/// background agents. Claude Code ends its turn while they run, but the session is not done. The same rules as the
/// agent's (agent/src/transcript/background.ts).
public struct BackgroundTasks: Equatable, Sendable {
    /// When each task started, by id.
    public private(set) var running: [String: Date] = [:]
    /// A task that never reported back after this long no longer counts: Monitors run an hour at most.
    static let lifetime: TimeInterval = 2 * 3600

    public init() {}

    /// One line of a transcript.
    public mutating func read(_ line: String, now: Date = Date()) {
        guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { return }
        let at = (object["timestamp"] as? String).flatMap(ISO8601.parse) ?? now
        for text in Self.texts((object["message"] as? [String: Any])?["content"]) {
            if text.contains("You will be notified when"),
                let started = text.firstMatch(of: #/(?i)\b(?:with ID|agentId|task ?id)[:\s]+([A-Za-z0-9_-]{5,64})/#)
            {
                running[String(started.1)] = at
            }
            if let stopped = text.firstMatch(of: #/(?i)stopped task:\s*([A-Za-z0-9_-]+)/#) { running[String(stopped.1)] = nil }
            for ended in text.matches(of: #/<task-id>\s*([A-Za-z0-9_-]+)\s*</task-id>[\s\S]*?<status>\s*(\w+)\s*</status>/#)
            where Self.over.contains(ended.2.lowercased()) {
                running[String(ended.1)] = nil
            }
        }
    }

    public func count(at now: Date = Date()) -> Int {
        running.values.filter { now.timeIntervalSince($0) < Self.lifetime }.count
    }

    /// What the session waits for, while tasks run: "Waiting for 2 background tasks".
    public func waiting(at now: Date = Date()) -> String? {
        let count = count(at: now)
        return count == 0 ? nil : "Waiting for \(count) background task\(count == 1 ? "" : "s")"
    }

    private static let over: Set = ["completed", "failed", "killed", "stopped", "cancelled", "canceled", "error", "timeout"]

    private static func texts(_ content: Any?) -> [String] {
        if let text = content as? String { return [text] }
        guard let blocks = content as? [Any] else { return [] }
        return blocks.flatMap { block -> [String] in
            guard let block = block as? [String: Any] else { return [] }
            if block["type"] as? String == "text", let text = block["text"] as? String { return [text] }
            if block["type"] as? String == "tool_result" { return texts(block["content"]) }
            return []
        }
    }
}
