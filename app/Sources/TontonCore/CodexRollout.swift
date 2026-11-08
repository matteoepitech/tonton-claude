import Foundation

/// Codex's rollouts (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`) read as agent/src/codex/rollout.ts reads them, for
/// the Codex sessions of this Mac that no agent reports. Keep the two in step: both read agent/test/fixtures/codex-*.jsonl.
/// Each line is `{ timestamp, type, payload }`, with `type` one of session_meta, turn_context, response_item, event_msg or
/// compacted. It is not a public format: anything unexpected is skipped, never thrown.
///
/// A prompt is in the rollout twice, as the model's input (a `message` response item) and as the user's (a `user_message`
/// event): the event is the one shown, the model's input only lends it its images. Entries have the agent's ids, made from
/// the line, so both copies of a session line up.
public struct CodexRollout {
    /// Calls waiting for their output, and commands still running: a session that never ends them must not fill memory.
    static let maxPending = 500
    static let maxTitleChars = 80
    static let maxReasoningChars = 160
    static let maxErrorChars = 300
    static let maxToolResultChars = 4000
    static let toolResultTailChars = 1500
    /// Like the agent's: larger images stay out, and an entry keeps the ones that fit in its budget.
    static let maxImageBase64 = 4 * 1024 * 1024
    static let maxEntryImagesBase64 = 5 * 1024 * 1024
    /// What Codex adds to a conversation as the user's and that nobody typed.
    static let internalUserTags = [
        "environment_context", "user_instructions", "permissions instructions", "turn_aborted", "user_shell_command", "skill",
        "collaboration_mode",
    ]

    /// Who the rollout belongs to, from its `session_meta` line.
    public struct Session: Equatable, Sendable {
        /// What Codex's hooks call `session_id`, the same for a thread and its subagents: the id the agent reports the
        /// session under.
        public let sessionId: String
        public let threadId: String
        public let cwd: String?
        public let branch: String?
        public let started: Date?
        /// A subagent's thread: its work is in its parent's turn.
        public let subagent: Bool
    }

    /// The 5-hour and weekly windows of the ChatGPT plan Codex runs on, as the agent sends them
    /// (`codexPlanWindows` in agent/src/codex/limits.ts): a window of another length, or without a reset time, is left out.
    public struct PlanWindows: Equatable, Sendable {
        public var fiveHour: UsageLimit?
        public var sevenDay: UsageLimit?
    }

    /// A turn started or ended.
    public enum Status: Equatable, Sendable { case working, idle }

    public struct Line: Equatable, Sendable {
        public var entries: [Entry] = []
        /// The first prompt, on one line.
        public var title: String?
        /// The tokens of the response a `token_count` event follows, once per response.
        public var usage: Transcript.ResponseUsage?
        public var contextWindow: Int?
        /// Codex compacted the conversation: the context starts over.
        public var compacted = false
        public var model: String?
        public var session: Session?
        public var status: Status?
        /// The windows of the ChatGPT plan, from Codex's latest reading of them.
        public var planWindows: PlanWindows?
    }

    private enum Call { case shell(String), patch, hidden, other }

    private var cwd: String?
    private var calls = Bounded<Call>()
    /// Commands still running after their call returned, by the session id `write_stdin` names.
    private var running = Bounded<String>()
    /// apply_patch calls already shown as their files, and those Codex could not apply.
    private var patched = Bounded<Bool>()
    private var failedPatches = Bounded<Bool>()
    /// The images of the prompt the model got, for the `user_message` event that follows.
    private var images: [ImageData] = []
    private var titled = false

    public init() {}

    /// One line, read from the start of the rollout or from anywhere in it: calls are matched to their output by id.
    public mutating func line(_ raw: String) -> Line {
        var result = Line()
        guard let data = raw.data(using: .utf8), let line = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let payload = line["payload"] as? [String: Any]
        else { return result }
        let stamp = (line["timestamp"] as? String).flatMap { ISO8601.parse($0) == nil ? nil : $0 }
        let ts = stamp ?? ISO8601DateFormatter().string(from: Date())
        let id = Self.entryId(raw)
        switch line["type"] as? String {
        case "session_meta": sessionMeta(payload, stamp, &result)
        case "turn_context": turnContext(payload, &result)
        case "response_item": responseItem(payload, id, ts, &result)
        case "event_msg": event(payload, id, ts, raw, &result)
        case "compacted": result.compacted = true
        default: break
        }
        return result
    }

    /// `cx-` and the line's hash, as the agent writes it (`Bun.hash`).
    static func entryId(_ raw: String) -> String { "cx-\(String(Wyhash.hash(raw.utf8), radix: 36))" }

    /// The session of a rollout's first line, which the Mac reads apart: a long rollout is only read from its end.
    public static func session(_ raw: String) -> Session? {
        var rollout = CodexRollout()
        return rollout.line(raw).session
    }

    /// The names users gave threads (`/rename`), from Codex's `session_index.jsonl`, by thread: the newest entry wins.
    public static func threadNames(_ index: String) -> [String: String] {
        var names: [String: String] = [:]
        for line in index.split(separator: "\n") {
            guard let entry = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any], let id = entry["id"] as? String,
                let name = (entry["thread_name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty
            else { continue }
            names[id] = name
        }
        return names
    }

    // MARK: Lines

    private mutating func sessionMeta(_ payload: [String: Any], _ stamp: String?, _ result: inout Line) {
        guard let threadId = text(payload["id"]) else { return }
        if let cwd = text(payload["cwd"]) { self.cwd = cwd }
        let source = payload["source"] as? [String: Any]
        let started = (text(payload["timestamp"]) ?? stamp).flatMap(ISO8601.parse)
        result.session = Session(
            sessionId: text(payload["session_id"]) ?? threadId, threadId: threadId, cwd: text(payload["cwd"]),
            branch: text((payload["git"] as? [String: Any])?["branch"]), started: started,
            subagent: text(payload["parent_thread_id"]) != nil || source?.keys.contains("subagent") == true)
    }

    private mutating func turnContext(_ payload: [String: Any], _ result: inout Line) {
        if let cwd = text(payload["cwd"]) { self.cwd = cwd }
        if let model = payload["model"] as? String, model != "<synthetic>", model.wholeMatch(of: #/[A-Za-z0-9_.:@\[\]\/-]{1,100}/#) != nil {
            result.model = model
        }
    }

    private mutating func responseItem(_ item: [String: Any], _ id: String, _ ts: String, _ result: inout Line) {
        switch item["type"] as? String {
        case "message":
            message(item, id, ts, &result)
        case "reasoning":
            let summary = (item["summary"] as? [Any] ?? []).compactMap { text(($0 as? [String: Any])?["text"]) }
            if let heading = summary.first.flatMap(Self.reasoningHeading) {
                result.entries.append(Entry(id: id, ts: ts, kind: .system, text: heading))
            }
        case "function_call":
            if let callId = text(item["call_id"]), let name = text(item["name"]) {
                call(callId, name, text(item["namespace"]), Self.arguments(item["arguments"]), id, ts, &result)
            }
        case "custom_tool_call":
            if let callId = text(item["call_id"]), let name = text(item["name"]) {
                call(callId, name, nil, ["input": item["input"] as? String ?? ""], id, ts, &result)
            }
        case "local_shell_call":
            if let callId = text(item["call_id"]) ?? text(item["id"]) {
                let command = (item["action"] as? [String: Any])?["command"]
                call(callId, "local_shell", nil, command.map { ["command": $0] } ?? [:], id, ts, &result)
            }
        case "function_call_output", "custom_tool_call_output":
            if let callId = text(item["call_id"]) { output(callId, item["output"], id, ts, &result) }
        case "image_generation_call":
            guard let image = text(item["result"]) else { return }
            let callId = text(item["id"]) ?? id
            let summary = Transcript.toolSummary("image_generation", ["prompt": text(item["revised_prompt"]) ?? ""])
            result.entries.append(Entry(id: id, ts: ts, kind: .tool, toolUseId: callId, name: "image_generation", summary: summary))
            let (shown, kept) = Self.withImages("", [ImageData(mediaType: "image/png", data: image)])
            result.entries.append(
                Entry(id: "\(id):result", ts: ts, kind: .toolResult, text: shown, images: kept, toolUseId: callId, isError: false))
        default:
            break
        }
    }

    /// An answer is shown; a prompt only lends its images to the event that shows it.
    private mutating func message(_ item: [String: Any], _ id: String, _ ts: String, _ result: inout Line) {
        let content = (item["content"] as? [Any] ?? []).compactMap { $0 as? [String: Any] }
        switch item["role"] as? String {
        case "assistant":
            let body = content.compactMap { $0["type"] as? String == "output_text" ? $0["text"] as? String : nil }.joined(separator: "\n")
            if !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                result.entries.append(Entry(id: id, ts: ts, kind: .assistant, text: body))
            }
        case "user":
            let images = Self.dataImages(content.compactMap { $0["type"] as? String == "input_image" ? $0["image_url"] : nil })
            if !images.isEmpty { self.images = images }
        default:
            break
        }
    }

    private mutating func call(
        _ callId: String, _ name: String, _ namespace: String?, _ input: [String: Any], _ id: String, _ ts: String, _ result: inout Line
    ) {
        let tool = CodexTools.name(name, namespace: namespace)
        func entry(_ toolName: String, _ summary: String, todos: [TodoItem]? = nil) -> Entry {
            Entry(id: id, ts: ts, kind: .tool, toolUseId: callId, name: toolName, summary: summary, todos: todos)
        }
        if namespace == nil && name == "apply_patch" {
            let files = CodexTools.patchFiles(input["input"] as? String ?? "", cwd: cwd)
            calls[callId] = .patch
            guard !files.isEmpty else { return result.entries.append(entry("apply_patch", "")) }
            patched[callId] = true
            result.entries += Self.fileEntries(files, id, ts, callId)
            return
        }
        if tool == "ToolSearch" {
            calls[callId] = .hidden
            return
        }
        if namespace == nil && CodexTools.shellTools.contains(name) {
            let command = CodexTools.shellCommand(input) ?? ""
            calls[callId] = .shell(command)
            result.entries.append(entry("Bash", Transcript.toolSummary("Bash", ["command": command])))
            return
        }
        if namespace == nil && name == "write_stdin" {
            // Polling a command that is still running reads as that command again: its output, and how it ended, are its own.
            if let command = Self.string(input["session_id"]).flatMap({ running[$0] }) {
                calls[callId] = .shell(command)
                result.entries.append(entry("Bash", Transcript.toolSummary("Bash", ["command": command])))
            } else {
                calls[callId] = .other
                result.entries.append(entry(name, Transcript.toolSummary(name, ["chars": text(input["chars"]) ?? ""])))
            }
            return
        }
        calls[callId] = .other
        switch tool {
        case "TodoWrite":
            let plan = (input["plan"] as? [Any] ?? []).map { step in
                let fields = step as? [String: Any] ?? [:]
                return ["content": fields["step"], "status": fields["status"]].compactMapValues { $0 }
            }
            let todos = TodoList.items("TodoWrite", ["todos": plan])
            result.entries.append(entry("TodoWrite", Transcript.toolSummary("TodoWrite", [:]), todos: todos))
        case "Read":
            result.entries.append(entry("Read", Transcript.toolSummary("Read", ["file_path": text(input["path"]) ?? ""])))
        case "Task":
            let fields = ["description": text(input["task_name"]), "prompt": text(input["message"])].compactMapValues { $0 }
            result.entries.append(entry("Task", Transcript.toolSummary("Task", fields)))
        case "AskUserQuestion":
            let first = (input["questions"] as? [Any])?.first as? [String: Any]
            result.entries.append(entry(tool, Transcript.toolSummary(tool, ["question": text(first?["question"]) ?? ""])))
        default:
            result.entries.append(entry(tool, Transcript.toolSummary(tool, input)))
        }
    }

    private mutating func output(_ callId: String, _ output: Any?, _ id: String, _ ts: String, _ result: inout Line) {
        let call = calls[callId]
        if case .hidden = call { return }
        let body = Self.outputBody(output)
        var shown = body.text
        var isError = false
        switch call {
        case .shell(let command):
            let run = Self.execResult(body.text)
            if let session = run.session, !command.isEmpty { running[session] = command }
            (shown, isError) = (run.text, run.isError)
        case .patch:
            // Codex applies a patch itself, or through its shell runtime, whose output has the shell's header.
            let run = Self.execResult(body.text)
            shown = run.text
            let trimmed = shown.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            isError =
                run.isError || failedPatches[callId] != nil || trimmed.hasPrefix("apply_patch verification failed")
                || trimmed.hasPrefix("failed to apply")
        default:
            break
        }
        let (cutText, images) = Self.withImages(Self.cutToolResult(shown), body.images)
        result.entries.append(Entry(id: id, ts: ts, kind: .toolResult, text: cutText, images: images, toolUseId: callId, isError: isError))
    }

    private mutating func event(_ event: [String: Any], _ id: String, _ ts: String, _ raw: String, _ result: inout Line) {
        switch event["type"] as? String {
        case "user_message":
            prompt(event, id, ts, &result)
        case "task_started", "turn_started":
            if let window = Self.positive(event["model_context_window"]) { result.contextWindow = Int(window) }
            result.status = .working
        case "task_complete", "turn_complete":
            result.status = .idle
        case "turn_aborted":
            if event["reason"] as? String == "interrupted" {
                result.entries.append(Entry(id: id, ts: ts, kind: .system, text: "Interrupted by user"))
            }
            result.status = .idle
        case "token_count":
            Self.tokenCount(event, &result)
        case "context_compacted":
            result.compacted = true
            result.entries.append(Entry(id: id, ts: ts, kind: .system, text: "Conversation compacted"))
        case "patch_apply_end":
            guard let callId = text(event["call_id"]) else { return }
            if event["success"] as? Bool == false { failedPatches[callId] = true }
            guard patched[callId] == nil else { return }
            patched[callId] = true
            let changes = event["changes"] as? [String: Any] ?? [:]
            let files = Self.inOrder(changes.keys, of: raw, after: #""changes""#).compactMap { CodexTools.appliedFile($0, changes[$0]) }
            result.entries += Self.fileEntries(files, id, ts, callId)
        case "web_search_end":
            let callId = text(event["call_id"]) ?? id
            let action = event["action"] as? [String: Any] ?? [:]
            let query = text(event["query"]) ?? text(action["query"]) ?? text(action["url"]) ?? ""
            let summary = Transcript.toolSummary("WebSearch", ["query": query])
            result.entries.append(Entry(id: id, ts: ts, kind: .tool, toolUseId: callId, name: "WebSearch", summary: summary))
            result.entries.append(Entry(id: "\(id):result", ts: ts, kind: .toolResult, text: "", toolUseId: callId, isError: false))
        case "error":
            if let message = text(event["message"]) {
                result.entries.append(Entry(id: id, ts: ts, kind: .system, text: Self.cut(message, Self.maxErrorChars)))
            }
        default:
            break
        }
    }

    private mutating func prompt(_ event: [String: Any], _ id: String, _ ts: String, _ result: inout Line) {
        let body = event["message"] as? String ?? ""
        let shown = Self.dataImages(event["images"] as? [Any] ?? [])
        let images = shown.isEmpty ? self.images : shown
        self.images = []
        if (body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images.isEmpty) || Self.isInternal(body) { return }
        let (shownText, kept) = Self.withImages(body, images)
        result.entries.append(Entry(id: id, ts: ts, kind: .user, text: shownText, images: kept))
        guard !titled else { return }
        let oneLine = body.replacing(#/\s+/#, with: " ").trimmingCharacters(in: .whitespaces)
        if !oneLine.isEmpty {
            titled = true
            result.title = oneLine.utf16.count > Self.maxTitleChars ? "\(Self.cut(oneLine, Self.maxTitleChars))…" : oneLine
        }
    }

    // MARK: Helpers

    /// One entry per file a patch changes, each under the patch's call id: its output says whether they all went in.
    private static func fileEntries(_ files: [CodexTools.PatchFile], _ id: String, _ ts: String, _ callId: String) -> [Entry] {
        files.enumerated().map { index, file in
            Entry(
                id: "\(id):\(index)", ts: ts, kind: .tool, toolUseId: callId, name: file.tool,
                summary: Transcript.toolSummary(file.tool, ["file_path": file.path]), edits: file.edits.isEmpty ? nil : file.edits)
        }
    }

    private static func tokenCount(_ event: [String: Any], _ result: inout Line) {
        let info = event["info"] as? [String: Any]
        func count(_ value: Any?) -> Int { positive(value).map { Int($0) } ?? 0 }
        if let last = info?["last_token_usage"] as? [String: Any],
            let total = positive((info?["total_token_usage"] as? [String: Any])?["total_tokens"])
        {
            let input = count(last["input_tokens"])
            let cached = min(input, count(last["cached_input_tokens"]))
            // Reasoning is in the output already: `reasoning_output_tokens` is its share.
            let tokens = TokenCounts(input: input - cached, output: count(last["output_tokens"]), cacheRead: cached, cacheWrite: 0)
            result.usage = Transcript.ResponseUsage(requestId: "codex-total-\(number(total))", tokens: tokens)
        }
        if let window = positive(info?["model_context_window"]) { result.contextWindow = Int(window) }
        if let limits = event["rate_limits"] as? [String: Any] { result.planWindows = planWindows(limits) }
    }

    /// Each window goes by its length when Codex gives it, else by its place: `primary` is the 5-hour one, `secondary` the
    /// week. Nil when Codex says nothing of its windows.
    static func planWindows(_ limits: [String: Any]) -> PlanWindows? {
        var windows = PlanWindows()
        var said = limits["rate_limit_reached_type"] as? String != nil
        for (place, minutes) in [("primary", 300.0), ("secondary", 7 * 24 * 60.0)] {
            guard let window = limits[place] as? [String: Any], let used = window["used_percent"] as? NSNumber, !isBool(used),
                used.doubleValue.isFinite
            else { continue }
            said = true
            guard let resets = positive(window["resets_at"]) else { continue }
            let limit = UsageLimit(usedPercent: min(100, max(0, used.doubleValue)), resetsAt: Date(timeIntervalSince1970: resets))
            switch positive(window["window_minutes"]) ?? minutes {
            case 300: windows.fiveHour = limit
            case 7 * 24 * 60: windows.sevenDay = limit
            default: break
            }
        }
        return said ? windows : nil
    }

    /// A shell call's output as Claude Code's Bash shows it: the output alone, after `Exit code N` when the command failed,
    /// and `Command running in background` while it still runs. Codex writes a header before `Output:` (`Exit code: N` for
    /// shell_command, `Process exited with code N` or `Process running with session ID N` for exec_command), or, in older
    /// versions, `{ output, metadata: { exit_code } }`.
    static func execResult(_ raw: String) -> (text: String, isError: Bool, session: String?) {
        if raw.hasPrefix("{"), let json = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any],
            let output = json["output"] as? String, let code = (json["metadata"] as? [String: Any])?["exit_code"] as? NSNumber,
            !isBool(code)
        {
            let exit = code.doubleValue
            return (exit != 0 ? "Exit code \(number(exit))\n\(output)" : output, exit != 0, nil)
        }
        let marker = raw.hasPrefix("Output:") ? raw.startIndex..<raw.index(raw.startIndex, offsetBy: 7) : raw.range(of: "\nOutput:")
        guard let marker else {
            // No header: Codex refused the call (rejected, sandbox denied) before it ran.
            let first = raw.trimmingCharacters(in: .whitespacesAndNewlines).prefix { $0 != "\n" }
            let refused = String(first).firstMatch(
                of: #/^(exec command rejected|.*\brejected by user|execution error|failed to (spawn|execute|run))/#.ignoresCase())
            return (raw, refused != nil, nil)
        }
        let header = String(raw[..<marker.lowerBound])
        var output = raw[marker.upperBound...]
        if output.hasPrefix("\n") { output = output.dropFirst() }
        if let session = header.firstMatch(of: #/(?m)^Process running with session ID (\S+)/#) {
            return ("Command running in background\n\(output)", false, String(session.1))
        }
        let code = header.firstMatch(of: #/(?m)^(?:Exit code:|Process exited with code) (-?\d+)/#).flatMap { Int($0.1) } ?? 0
        return (code != 0 ? "Exit code \(code)\n\(output)" : String(output), code != 0, nil)
    }

    /// A call's output is text, or content items: `input_text`, and `input_image` with a data URL, as view_image returns.
    private static func outputBody(_ output: Any?) -> (text: String, images: [ImageData]) {
        if let text = output as? String { return (text, []) }
        let items = (output as? [Any] ?? []).compactMap { $0 as? [String: Any] }
        let texts = items.compactMap { $0["type"] as? String == "input_text" ? $0["text"] as? String : nil }
        let images = dataImages(items.compactMap { $0["type"] as? String == "input_image" ? $0["image_url"] : nil })
        return (texts.joined(separator: "\n"), images)
    }

    /// Images given as data URLs; Codex passes pasted and viewed images to the model that way. Read without a regex: one
    /// can weigh megabytes.
    static func dataImages(_ urls: [Any]) -> [ImageData] {
        urls.compactMap { url in
            guard let url = url as? String, url.hasPrefix("data:image/"), let marker = url.range(of: ";base64,") else { return nil }
            let mediaType = String(url[url.index(url.startIndex, offsetBy: 5)..<marker.lowerBound])
            let data = url[marker.upperBound...]
            guard mediaType.wholeMatch(of: #/image\/[A-Za-z0-9_.+-]+/#) != nil, !data.isEmpty,
                data.utf8.allSatisfy({ isBase64($0) })
            else { return nil }
            return ImageData(mediaType: mediaType, data: String(data))
        }
    }

    private static func isBase64(_ byte: UInt8) -> Bool {
        (65...90).contains(byte) || (97...122).contains(byte) || (48...57).contains(byte) || byte == 43 || byte == 47 || byte == 61
    }

    /// The images that fit in an entry, in order, and a note in its text for the others.
    static func withImages(_ text: String, _ images: [ImageData]) -> (text: String, images: [ImageData]?) {
        var left = maxEntryImagesBase64
        var kept: [ImageData] = []
        for image in images where image.data.utf8.count <= maxImageBase64 && image.data.utf8.count <= left {
            kept.append(image)
            left -= image.data.utf8.count
        }
        let dropped = images.count - kept.count
        let note = "[\(dropped) image\(dropped == 1 ? "" : "s") not loaded]"
        let shown = dropped == 0 ? text : text.isEmpty ? note : "\(text)\n\(note)"
        return (shown, kept.isEmpty ? nil : kept)
    }

    /// A reasoning summary as one short line: its bold heading, as Codex's own UI shows it, or its first sentence.
    static func reasoningHeading(_ summary: String) -> String? {
        let bold = summary.firstMatch(of: #/^\s*\*\*(.+?)\*\*/#).map { String($0.1) }
        let first = bold ?? summary.components(separatedBy: "\n").first { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? ""
        let line = first.replacing(#/\s+/#, with: " ").trimmingCharacters(in: .whitespaces)
        guard !line.isEmpty else { return nil }
        return line.utf16.count > maxReasoningChars ? "\(cut(line, maxReasoningChars))…" : line
    }

    private static func isInternal(_ body: String) -> Bool {
        let start = body.drop { $0.isWhitespace }
        return internalUserTags.contains { tag in
            guard start.hasPrefix("<\(tag)") else { return false }
            let next = start.dropFirst(tag.count + 1).first
            return next.map { !($0.isLetter || $0.isNumber || $0 == "_") } ?? true
        }
    }

    /// The agent cuts a long result at both ends: the start of a command's output and how it ended.
    static func cutToolResult(_ text: String) -> String {
        guard text.utf16.count > maxToolResultChars else { return text }
        let head = cut(text, maxToolResultChars - toolResultTailChars)
        let tail = cutEnd(text, toolResultTailChars)
        return "\(head)\n… (\(text.utf16.count - head.utf16.count - tail.utf16.count) characters truncated)\n\(tail)"
    }

    /// At most `max` UTF-16 units, never half a character, like shared/text.ts.
    static func cut(_ text: String, _ max: Int) -> String {
        guard text.utf16.count > max else { return text }
        var units = Array(text.utf16.prefix(max))
        if let last = units.last, UTF16.isLeadSurrogate(last) { units.removeLast() }
        return String(decoding: units, as: UTF16.self)
    }

    static func cutEnd(_ text: String, _ max: Int) -> String {
        guard text.utf16.count > max else { return text }
        var units = Array(text.utf16.suffix(max))
        if let first = units.first, UTF16.isTrailSurrogate(first) { units.removeFirst() }
        return String(decoding: units, as: UTF16.self)
    }

    /// The keys of an object in the order the line has them, which a dictionary loses: the agent numbers a patch's files
    /// in that order. Keys not found go last, by name.
    static func inOrder(_ keys: some Collection<String>, of raw: String, after field: String) -> [String] {
        let start = raw.range(of: field)?.upperBound ?? raw.startIndex
        func position(_ key: String) -> String.Index? {
            guard let encoded = try? JSONSerialization.data(withJSONObject: [key], options: [.withoutEscapingSlashes]) else { return nil }
            let quoted = String(decoding: encoded.dropFirst().dropLast(), as: UTF8.self)
            return raw.range(of: "\(quoted):", range: start..<raw.endIndex)?.lowerBound
        }
        return keys.map { ($0, position($0)) }
            .sorted { first, second in
                switch (first.1, second.1) {
                case (let a?, let b?): a < b
                case (.some, nil): true
                case (nil, .some): false
                case (nil, nil): first.0 < second.0
                }
            }
            .map(\.0)
    }

    private static func arguments(_ raw: Any?) -> [String: Any] {
        guard let raw = raw as? String else { return raw as? [String: Any] ?? [:] }
        return (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any] ?? [:]
    }

    /// A string, or a number as JavaScript's `String` writes it.
    private static func string(_ value: Any?) -> String? {
        if let text = value as? String { return text }
        guard let value = value as? NSNumber, !isBool(value) else { return nil }
        return number(value.doubleValue)
    }

    private static func number(_ value: Double) -> String {
        value.rounded() == value && abs(value) < 1e15 ? String(Int(value)) : String(value)
    }

    static func positive(_ value: Any?) -> Double? {
        guard let value = value as? NSNumber, !isBool(value), value.doubleValue.isFinite, value.doubleValue > 0 else { return nil }
        return value.doubleValue
    }

    private static func isBool(_ value: NSNumber) -> Bool { CFGetTypeID(value) == CFBooleanGetTypeID() }
}

/// A non-blank string, as it is.
private func text(_ value: Any?) -> String? {
    guard let value = value as? String, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    return value
}

/// A map that forgets its oldest keys past `CodexRollout.maxPending`.
private struct Bounded<Value> {
    private var values: [String: Value] = [:]
    private var order: [String] = []

    subscript(key: String) -> Value? {
        get { values[key] }
        set {
            guard let newValue else { return }
            if values.updateValue(newValue, forKey: key) == nil { order.append(key) }
            if order.count > CodexRollout.maxPending { values[order.removeFirst()] = nil }
        }
    }
}
