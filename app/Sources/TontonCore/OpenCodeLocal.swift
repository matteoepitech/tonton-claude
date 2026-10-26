import Foundation

/// The OpenCode 2 sessions of this Mac, read from OpenCode's own background service: like `LocalSessions` for Claude Code,
/// they show up in the notch without an agent, an account or a relay. The service also takes messages, answers to
/// permission requests and compactions, so the notch can drive them. OpenCode 1 runs no service to find: its sessions
/// need the agent. Its API is not a format Tonton controls: anything unexpected is skipped.
public enum OpenCodeLocal {
    /// Sessions not updated for this long stay out of the list: OpenCode keeps every session it ever had.
    public static let recent: TimeInterval = 12 * 3600
    static let maxEntries = 400
    static let maxToolResultChars = 4000

    /// Where the service listens, and its password. Only on this Mac: the password never goes anywhere else.
    public struct Service: Equatable, Sendable {
        public let url: URL
        let password: String

        public var authorization: String { "Basic " + Data("opencode:\(password)".utf8).base64EncodedString() }
    }

    /// `$XDG_STATE_HOME/opencode/service.json`, else `~/.local/state/opencode/service.json`. Nil when OpenCode 2's service
    /// never ran, or when it listens anywhere but on this Mac.
    public static func service(
        home: URL = FileManager.default.homeDirectoryForCurrentUser, environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> Service? {
        let state = environment["XDG_STATE_HOME"].map { URL(fileURLWithPath: $0) } ?? home.appendingPathComponent(".local/state")
        let file = state.appendingPathComponent("opencode/service.json")
        guard let data = try? Data(contentsOf: file),
            let fields = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let address = fields["url"] as? String, let url = URL(string: address), let password = fields["password"] as? String,
            ["127.0.0.1", "localhost", "::1"].contains(url.host ?? "")
        else { return nil }
        return Service(url: url, password: password)
    }

    /// One session of `GET /api/session`.
    public struct Listed: Equatable, Sendable {
        public let id: String
        public let title: String?
        public let directory: String
        public let created: Date
        public let updated: Date
        /// Set once a turn ended: `succeeded`, `failed`…
        public let outcome: String?
        public let idle: Date?
        public let costUSD: Double?
        public let tokens: TokenCounts?
        public let model: String?
    }

    /// The sessions of the list worth showing: recent, and not a subagent's.
    public static func sessions(_ data: Data, now: Date = Date()) -> [Listed] {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let list = root["data"] as? [[String: Any]]
        else { return [] }
        return list.compactMap { listed($0) }.filter { now.timeIntervalSince($0.updated) < recent }
    }

    static func listed(_ fields: [String: Any]) -> Listed? {
        guard let id = fields["id"] as? String, !id.isEmpty, fields["parentID"] == nil else { return nil }
        let time = fields["time"] as? [String: Any] ?? [:]
        let location = fields["location"] as? [String: Any]
        guard let directory = location?["directory"] as? String ?? fields["directory"] as? String else { return nil }
        let date = { (key: String) in (time[key] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) } }
        let model = (fields["model"] as? [String: Any])?["id"] as? String
        return Listed(
            id: id, title: (fields["title"] as? String).flatMap { $0.isEmpty ? nil : $0 }, directory: directory,
            created: date("created") ?? .distantPast, updated: date("updated") ?? date("created") ?? .distantPast,
            outcome: fields["outcome"] as? String, idle: date("idle"), costUSD: (fields["cost"] as? NSNumber)?.doubleValue,
            tokens: (fields["tokens"] as? [String: Any]).map(tokens), model: model)
    }

    /// What `GET /api/session/{id}/context` says, as the notch shows it.
    public struct Conversation: Equatable, Sendable {
        public var entries: [Entry] = []
        /// The last message is a prompt, or an answer still being written.
        public var working = false
        /// The input of the last answer, for the context gauge.
        public var contextTokens: Int?
    }

    /// OpenCode's messages: prompts, answers and tool calls with their results, under the ids the agent's bridge gives
    /// them (agent/src/opencode/events.ts), so both copies of a session line up.
    public static func conversation(_ data: Data) -> Conversation {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let messages = root["data"] as? [[String: Any]]
        else { return Conversation() }
        var conversation = Conversation()
        var last: (type: String, completed: Bool)?
        for message in messages {
            guard let id = message["id"] as? String, let type = message["type"] as? String else { continue }
            let time = message["time"] as? [String: Any] ?? [:]
            let ts = timestamp(time["created"])
            last = (type, time["completed"] != nil)
            switch type {
            case "user":
                if let text = message["text"] as? String, !text.isEmpty {
                    conversation.entries.append(Entry(id: id, ts: ts, kind: .user, text: text))
                }
            case "assistant":
                if let usage = message["tokens"] as? [String: Any] {
                    let counts = tokens(usage)
                    conversation.contextTokens = counts.input + counts.cacheRead + counts.cacheWrite
                }
                conversation.entries += assistantEntries(id, ts, message["content"] as? [[String: Any]] ?? [])
            default: break
            }
        }
        conversation.entries = Array(conversation.entries.suffix(maxEntries))
        conversation.working = last.map { $0.type == "user" || ($0.type == "assistant" && !$0.completed) } ?? false
        return conversation
    }

    private static func assistantEntries(_ id: String, _ ts: String, _ content: [[String: Any]]) -> [Entry] {
        var entries: [Entry] = []
        var ordinal = 0
        for item in content {
            if item["type"] as? String == "text", let text = item["text"] as? String, !text.isEmpty {
                entries.append(Entry(id: "\(id):\(ordinal)", ts: ts, kind: .assistant, text: text))
                ordinal += 1
            } else if item["type"] as? String == "tool", let call = item["id"] as? String {
                let state = item["state"] as? [String: Any] ?? [:]
                let name = toolNames[item["name"] as? String ?? ""] ?? item["name"] as? String ?? "tool"
                let input = claudeInput(state["input"] as? [String: Any] ?? [:])
                let edits = Transcript.fileEdits(name, input)
                entries.append(
                    Entry(
                        id: call, ts: ts, kind: .tool, toolUseId: call, name: name, summary: Transcript.toolSummary(name, input),
                        edits: edits.isEmpty ? nil : edits))
                let status = state["status"] as? String
                guard status == "completed" || status == "error" else { continue }
                let output =
                    status == "error"
                    ? (state["error"] as? [String: Any])?["message"] as? String ?? "The tool failed"
                    : (state["content"] as? [[String: Any]] ?? []).compactMap {
                        $0["type"] as? String == "text" ? $0["text"] as? String : nil
                    }
                    .joined(separator: "\n")
                entries.append(
                    Entry(id: "\(call):result", ts: ts, kind: .toolResult, text: cut(output), toolUseId: call, isError: status == "error"))
            }
        }
        return entries
    }

    /// `GET /api/session/{id}/permission`, as the notch's request cards.
    public static func permissions(_ data: Data) -> [PermissionRequest] {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let list = root["data"] as? [[String: Any]]
        else { return [] }
        return list.compactMap { request in
            guard let id = request["id"] as? String else { return nil }
            let action = request["action"] as? String ?? request["permission"] as? String ?? "tool"
            let name = toolNames[action] ?? action
            let subject = (request["resources"] as? [String] ?? request["patterns"] as? [String] ?? []).joined(separator: " ")
            let field = ruleFields[name] ?? "command"
            let preview = (try? JSONSerialization.data(withJSONObject: subject.isEmpty ? [:] : [field: subject])).map {
                String(decoding: $0, as: UTF8.self)
            }
            return PermissionRequest(
                requestId: id, toolName: name, description: subject.isEmpty ? name : subject, inputPreview: preview ?? "{}", ts: "")
        }
    }

    /// The session as the notch shows it.
    public static func summary(_ listed: Listed, _ conversation: Conversation, permissions: [PermissionRequest]) -> SessionSummary {
        let status: SessionStatus =
            !permissions.isEmpty ? .permission : conversation.working ? .working : listed.outcome == "failed" ? .error : .idle
        let project = URL(fileURLWithPath: listed.directory).lastPathComponent
        let last = conversation.entries.last { $0.kind == .user || $0.kind == .assistant }
        return SessionSummary(
            id: listed.id, machineId: LocalSessions.machineId, machine: "This Mac", platform: "darwin",
            cwd: listed.directory, project: project.isEmpty ? listed.directory : project, title: listed.title, status: status,
            statusText: permissions.first.map { "OpenCode needs your permission to use \($0.toolName)" }, agentOnline: true, canChat: true,
            pendingPermissions: permissions, costUSD: listed.costUSD, startedAt: listed.created, lastActivity: listed.updated,
            lastMessage: last?.text.map { String($0.prefix(200)) }, tokens: listed.tokens,
            context: conversation.contextTokens.map { ContextUsage(usedTokens: $0, windowTokens: nil) }, terminal: false,
            commands: [.compact], model: listed.model, tool: "opencode")
    }

    /// OpenCode's tools under Claude Code's names, as the agent's bridge maps them.
    static let toolNames: [String: String] = [
        "bash": "Bash", "shell": "Bash", "read": "Read", "write": "Write", "edit": "Edit", "multiedit": "MultiEdit", "patch": "Edit",
        "glob": "Glob", "grep": "Grep", "list": "LS", "webfetch": "WebFetch", "websearch": "WebSearch", "todowrite": "TodoWrite",
        "todoread": "TodoRead", "task": "Task", "subagent": "Task",
    ]
    private static let inputFields = ["filePath": "file_path", "oldString": "old_string", "newString": "new_string"]
    private static let ruleFields = [
        "Bash": "command", "Read": "file_path", "Write": "file_path", "Edit": "file_path", "MultiEdit": "file_path", "WebFetch": "url",
        "Glob": "pattern", "Grep": "pattern",
    ]

    private static func claudeInput(_ input: [String: Any]) -> [String: Any] {
        Dictionary(input.map { (inputFields[$0.key] ?? $0.key, $0.value) }) { first, _ in first }
    }

    private static func tokens(_ fields: [String: Any]) -> TokenCounts {
        func count(_ value: Any?) -> Int { (value as? NSNumber)?.intValue ?? 0 }
        let cache = fields["cache"] as? [String: Any] ?? [:]
        // Reasoning is billed as output.
        return TokenCounts(
            input: count(fields["input"]), output: count(fields["output"]) + count(fields["reasoning"]), cacheRead: count(cache["read"]),
            cacheWrite: count(cache["write"]))
    }

    private static func cut(_ text: String) -> String {
        text.count > maxToolResultChars
            ? "\(text.prefix(maxToolResultChars))\n… (\(text.count - maxToolResultChars) characters truncated)" : text
    }

    private static func timestamp(_ value: Any?) -> String {
        let date = (value as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) } ?? Date()
        return ISO8601DateFormatter().string(from: date)
    }
}
