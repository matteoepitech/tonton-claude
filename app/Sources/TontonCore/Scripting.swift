import Foundation

/// What AppleScript, and Shortcuts through its Run AppleScript action, see of the sessions, and how a script names one.
public enum ScriptSessions {
    public enum Failure: Error, Equatable {
        case notFound(String)
        /// Several live sessions have that project name: their ids.
        case ambiguous(String, [String])
        case cannotChat(String)
        /// Settings › General › Scripts can send messages is off.
        case sendingOff
        case emptyMessage

        public var message: String {
            switch self {
            case .notFound(let name): String(core: "No session is called \(name).")
            case .ambiguous(let name, let ids):
                String(core: "Several sessions are called \(name). Use one of these ids: \(ids.joined(separator: ", ")).")
            case .cannotChat(let name):
                String(core: "\(name) can't get messages: it needs a running agent, started with the chat channel.")
            case .sendingOff: String(core: "Scripts can't send messages. Turn it on in Tonton Claude › Settings › General.")
            case .emptyMessage: String(core: "The message is empty.")
            }
        }
    }

    public typealias Lookup = Result<SessionSummary, Failure>

    /// A session by its id, or by its project's name or the name given to it, ignoring case. Among sessions of the same project the live one
    /// wins; several live ones need the id. With none live, the latest one, so its status can still be read.
    public static func find(_ name: String, in sessions: [SessionSummary]) -> Lookup {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if let session = sessions.first(where: { $0.id == name }) { return .success(session) }
        let matching = sessions.filter {
            $0.project.caseInsensitiveCompare(name) == .orderedSame || $0.name?.caseInsensitiveCompare(name) == .orderedSame
        }
        let live = matching.filter(\.status.isLive)
        if live.count > 1 { return .failure(.ambiguous(name, live.map(\.id))) }
        if let session = live.first ?? matching.max(by: { $0.lastActivity < $1.lastActivity }) { return .success(session) }
        return .failure(.notFound(name))
    }

    /// The session a message goes to, or why it can't.
    public static func recipient(_ name: String, text: String, in sessions: [SessionSummary], allowed: Bool) -> Lookup {
        guard allowed else { return .failure(.sendingOff) }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .failure(.emptyMessage) }
        return find(name, in: sessions).flatMap { $0.canChat ? .success($0) : .failure(.cannotChat($0.project)) }
    }

    /// One session as a script record, in a stable order. Labels are lowercase words that are not AppleScript terms (`id`
    /// is one), so `session of item 1 of (session list)` compiles. Status is the raw value (`working`, `waiting`…), which
    /// scripts can compare; the cost is only there when costs are shown.
    public static func fields(_ session: SessionSummary, showCost: Bool) -> [(String, String)] {
        var fields = [
            ("session", session.id), ("project", session.project), ("machine", session.machine), ("status", session.status.rawValue),
            ("title", session.title ?? ""), ("folder", session.cwd),
        ]
        if showCost, let cost = session.costUSD { fields.append(("cost", String(format: "%.2f", cost))) }
        return fields
    }
}
