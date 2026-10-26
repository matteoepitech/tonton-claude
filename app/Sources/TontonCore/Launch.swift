import Foundation

/// A session the user starts from the notch: the agent runs claude in that folder of the machine and passes on the
/// questions Claude Code asks while it starts, until the session runs.
public struct SessionLaunch: Identifiable, Equatable, Sendable {
    public enum State: String, Equatable, Sendable {
        /// The order is on its way to the machine.
        case sending
        case starting, asking, started, failed
    }

    public let id: String
    public let machineId: String
    public let cwd: String
    public let state: State
    /// The question while `asking`, why while `failed`.
    public let text: String?
    /// Which question is asked: the answer names it, so it cannot be reused for another.
    public let step: Int?
    public let sessionId: String?

    public init(
        id: String = SessionLaunch.newId(), machineId: String, cwd: String, state: State = .sending, text: String? = nil,
        step: Int? = nil, sessionId: String? = nil
    ) {
        (self.id, self.machineId, self.cwd, self.state) = (id, machineId, cwd, state)
        (self.text, self.step, self.sessionId) = (text, step, sessionId)
    }

    /// 32 lowercase letters and digits, as the relay expects.
    public static func newId() -> String { UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased() }

    /// The launch once the machine reported where it stands. Unknown states leave it as it was.
    public func reported(_ state: String, detail: StartDetail?, reason: String?, sessionId: String?, machine: String) -> SessionLaunch {
        guard let next = State(rawValue: state), next != .sending else { return self }
        let text =
            reason == "offline"
            ? "\(machine) is offline. Check that it is on and that the Tonton Claude agent runs there." : detail?.text
        return SessionLaunch(
            id: id, machineId: machineId, cwd: cwd, state: next, text: text, step: next == .asking ? detail?.step : nil,
            sessionId: sessionId ?? self.sessionId)
    }

    public func failed(_ text: String) -> SessionLaunch {
        SessionLaunch(id: id, machineId: machineId, cwd: cwd, state: .failed, text: text, sessionId: sessionId)
    }

    /// The question asked, without the screen it was read from.
    public var question: String? {
        guard state == .asking, let text else { return nil }
        return text.components(separatedBy: "\n\n").first
    }

    /// The last lines of Claude Code's screen under the question, or under why it failed, without the margin they share.
    public var screen: String? {
        guard let text, let range = text.range(of: "\n\n") else { return nil }
        let lines = text[range.upperBound...].split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression) }
        let margin = lines.filter { !$0.isEmpty }.map { $0.prefix { $0 == " " }.count }.min() ?? 0
        let screen = lines.map { String($0.dropFirst(min(margin, $0.count))) }.joined(separator: "\n")
            .trimmingCharacters(in: .newlines)
        return screen.isEmpty ? nil : screen
    }

    /// What the user reads first: the question, or why the start failed.
    public var headline: String? { text?.components(separatedBy: "\n\n").first }

    public var isRunning: Bool { state != .started && state != .failed }
}

/// Folders the user is likely to start a session in, on one machine: the ones started from the notch, then the ones of
/// the machine's sessions, most recent first.
public enum RecentFolders {
    public static let limit = 8

    public static func list(started: [String], sessions: [SessionSummary], machineId: String) -> [String] {
        let seen = sessions.filter { $0.machineId == machineId && !$0.cwd.isEmpty }
            .sorted { $0.lastActivity > $1.lastActivity }
            .map(\.cwd)
        var unique: [String] = []
        for folder in started + seen where !unique.contains(normalized(folder)) { unique.append(normalized(folder)) }
        return Array(unique.prefix(limit))
    }

    /// `started` with `folder` first.
    public static func adding(_ folder: String, to started: [String]) -> [String] {
        let folder = normalized(folder)
        return Array(([folder] + started.filter { normalized($0) != folder }).prefix(limit))
    }

    /// Without the trailing slash, so `~/code/api/` and `~/code/api` are one folder.
    public static func normalized(_ folder: String) -> String {
        var folder = folder.trimmingCharacters(in: .whitespacesAndNewlines)
        while folder.count > 1, folder.hasSuffix("/") || folder.hasSuffix("\\") { folder.removeLast() }
        return folder
    }

    /// Where the agent can start claude: a full path, or one from the home folder.
    public static func isStartable(_ folder: String) -> Bool {
        let folder = normalized(folder)
        return folder.hasPrefix("/") || folder == "~" || folder.hasPrefix("~/")
    }
}
