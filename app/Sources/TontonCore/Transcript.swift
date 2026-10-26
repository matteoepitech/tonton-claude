import Foundation

/// Claude Code transcripts (.jsonl), read like agent/src/transcript/parser.ts reads them, for the sessions of this Mac
/// that no agent reports. Keep the two in step. The format is not public: anything unexpected is skipped, never thrown.
public enum Transcript {
    public struct ParsedLine: Equatable, Sendable {
        public var entries: [Entry] = []
        public var title: String?
        public var costUSD: Double?
        /// Set when the 5-hour limit stopped the session.
        public var fiveHourLimit: UsageLimit?
        /// Set when a weekly limit stopped the session.
        public var sevenDayLimit: UsageLimit?
        /// Claude Code writes one line per content block, each with the whole response's usage: they only count once per
        /// request.
        public var usage: ResponseUsage?
        /// The model's context window, read from the model the request asked for (`[1m]` for a million tokens).
        public var contextWindow: Int?
        /// Claude Code compacted the conversation: the context starts over.
        public var compacted = false
    }

    public struct ResponseUsage: Equatable, Sendable {
        public let requestId: String
        public let tokens: TokenCounts
    }

    static let maxToolResultChars = 4000
    static let maxImageBase64 = 4 * 1024 * 1024
    static let maxSummaryChars = 300
    /// Internal tools that would only add noise to the conversation.
    static let hiddenTools: Set = ["ToolSearch"]
    /// Which input field describes a tool call best, per tool.
    static let summaryFields: [String: [String]] = [
        "Bash": ["command"], "Read": ["file_path"], "Write": ["file_path"], "Edit": ["file_path"], "MultiEdit": ["file_path"],
        "NotebookEdit": ["notebook_path"], "WebFetch": ["url"], "WebSearch": ["query"], "Agent": ["description", "prompt"],
        "Task": ["description", "prompt"],
    ]
    static let fallbackSummaryFields = ["description", "command", "file_path", "path", "url", "query", "pattern", "prompt"]

    public static func parse(_ raw: String) -> ParsedLine {
        var result = ParsedLine()
        guard let data = raw.data(using: .utf8), let line = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            line["isSidechain"] as? Bool != true
        else { return result }

        let type = line["type"] as? String
        if type == "ai-title", let title = line["aiTitle"] as? String { result.title = title }
        if type == "cost-state", let cost = line["totalCostUSD"] as? Double { result.costUSD = cost }
        // On the error message Claude Code writes when the plan's limit refuses a request.
        if let quota = line["quotaLimits"] as? [String: Any], quota["status"] as? String == "rejected",
            let type = quota["rateLimitType"] as? String, let resetsAt = quota["resetsAt"] as? Double, resetsAt > 0
        {
            let limit = UsageLimit(usedPercent: 100, resetsAt: Date(timeIntervalSince1970: resetsAt))
            // The weekly limit, or its Opus or Sonnet share: either way the session waits for that reset.
            if type == "five_hour" { result.fiveHourLimit = limit } else if type.hasPrefix("seven_day") { result.sevenDayLimit = limit }
        }
        if type == "assistant" { result.usage = responseUsage(line) }
        if type == "assistant", let model = line["requestedModel"] as? String {
            result.contextWindow = model.lowercased().hasSuffix("[1m]") ? 1_000_000 : 200_000
        }

        let ts = line["timestamp"] as? String ?? ISO8601DateFormatter().string(from: Date())
        let id = line["uuid"] as? String ?? "\(type ?? "line")-\(ts)"
        if type == "system", line["subtype"] as? String == "compact_boundary" {
            result.compacted = true
            result.entries.append(Entry(id: id, ts: ts, kind: .system, text: "Conversation compacted"))
        }

        // A message sent while Claude is working waits in a queue and is only ever stored as this attachment.
        if type == "attachment", let queued = line["attachment"] as? [String: Any], queued["type"] as? String == "queued_command",
            queued["commandMode"] as? String ?? "prompt" == "prompt"
        {
            let viaNotch = (queued["origin"] as? [String: Any])?["kind"] as? String == "channel"
            result.entries += userEntries(id, ts, queued["prompt"]).map { entry in
                var entry = entry
                if viaNotch && entry.kind == .user { entry.viaNotch = true }
                return entry
            }
            return result
        }

        // Messages sent from the notch arrive through the channel and are stored as meta user messages.
        let fromChannel = (line["origin"] as? [String: Any])?["kind"] as? String == "channel"
        guard type == "user" || type == "assistant", !(line["isMeta"] as? Bool == true && !fromChannel),
            let message = line["message"] as? [String: Any]
        else { return result }

        if type == "user" {
            result.entries += userEntries(id, ts, message["content"])
        } else if let content = message["content"] as? [Any] {
            result.entries += assistantEntries(id, ts, content)
        }
        return result
    }

    public static func toolSummary(_ name: String, _ input: Any?) -> String {
        let fields = input as? [String: Any] ?? [:]
        func pick(_ keys: [String]) -> String? {
            keys.lazy.compactMap { fields[$0] as? String }.first { !$0.isEmpty }
        }
        let summary: String?
        if name == "Grep" || name == "Glob" {
            summary = [pick(["pattern"]), pick(["path"])].compactMap { $0 }.joined(separator: " in ")
        } else if name == "TodoWrite" {
            summary = "Updated the task list"
        } else {
            // JSONSerialization loses the key order: the first string by key name, where the agent takes the first one.
            summary =
                pick(summaryFields[name] ?? fallbackSummaryFields)
                ?? fields.keys.sorted().lazy.compactMap { fields[$0] as? String }.first
        }
        let oneLine = (summary ?? "").replacing(#/\s+/#, with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        return oneLine.utf16.count > maxSummaryChars ? "\(utf16Prefix(oneLine, maxSummaryChars))…" : oneLine
    }

    /// Lengths are counted in UTF-16 units, like JavaScript, so both parsers cut at the same place.
    private static func utf16Prefix(_ text: String, _ length: Int) -> String {
        String(decoding: Array(text.utf16.prefix(length)), as: UTF16.self)
    }

    /// Messages Claude Code makes up itself, such as API errors, are `<synthetic>` and cost nothing.
    private static func responseUsage(_ line: [String: Any]) -> ResponseUsage? {
        guard let message = line["message"] as? [String: Any], let usage = message["usage"] as? [String: Any],
            let requestId = line["requestId"] as? String ?? message["id"] as? String, message["model"] as? String != "<synthetic>"
        else { return nil }
        func count(_ field: String) -> Int { (usage[field] as? NSNumber)?.intValue ?? 0 }
        let tokens = TokenCounts(
            input: count("input_tokens"), output: count("output_tokens"), cacheRead: count("cache_read_input_tokens"),
            cacheWrite: count("cache_creation_input_tokens"))
        return ResponseUsage(requestId: requestId, tokens: tokens)
    }

    private static func userEntries(_ id: String, _ ts: String, _ content: Any?) -> [Entry] {
        if let text = content as? String { return [userMessage(id, ts, text, [])].compactMap { $0 } }
        guard let blocks = content as? [Any] else { return [] }

        var entries: [Entry] = []
        var texts: [String] = []
        var images: [ImageData] = []
        for (index, block) in blocks.enumerated() {
            guard let block = block as? [String: Any] else { continue }
            switch block["type"] as? String {
            case "text": if let text = block["text"] as? String { texts.append(text) }
            case "image": addImage(&images, block)
            case "tool_result": if !isToolSchemaResult(block) { entries.append(toolResult("\(id):\(index)", ts, block)) }
            default: break
            }
        }
        return entries + [userMessage(id, ts, texts.joined(separator: "\n"), images)].compactMap { $0 }
    }

    private static func assistantEntries(_ id: String, _ ts: String, _ content: [Any]) -> [Entry] {
        content.enumerated().compactMap { index, block in
            guard let block = block as? [String: Any] else { return nil }
            let entryId = "\(id):\(index)"
            if block["type"] as? String == "text", let text = block["text"] as? String,
                !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            {
                return Entry(id: entryId, ts: ts, kind: .assistant, text: text)
            }
            if block["type"] as? String == "tool_use", let name = block["name"] as? String, !hiddenTools.contains(name) {
                return Entry(
                    id: entryId, ts: ts, kind: .tool, toolUseId: block["id"] as? String ?? "", name: name,
                    summary: toolSummary(name, block["input"]))
            }
            return nil
        }
    }

    private static func userMessage(_ id: String, _ ts: String, _ raw: String, _ images: [ImageData]) -> Entry? {
        let images = images.isEmpty ? nil : images
        if let channel = raw.firstMatch(of: #/<channel source="[^"]*tonton[^"]*"[^>]*>([\s\S]*?)</channel>/#) {
            let text = String(channel.1).trimmingCharacters(in: .whitespacesAndNewlines)
            return Entry(id: id, ts: ts, kind: .user, text: text, images: images, viaNotch: true)
        }
        if raw.firstMatch(of: #/^\s*<(local-command-stdout|local-command-caveat|command-message|system-reminder)/#) != nil {
            return nil
        }
        if raw.firstMatch(of: #/^\s*<task-notification>/#) != nil {
            let summary = raw.firstMatch(of: #/<summary>([\s\S]*?)</summary>/#)
                .map { String($0.1).trimmingCharacters(in: .whitespacesAndNewlines) }
            return Entry(id: id, ts: ts, kind: .system, text: summary ?? "Background task finished")
        }
        if raw.firstMatch(of: #/^\[Request interrupted by user/#) != nil {
            return Entry(id: id, ts: ts, kind: .system, text: "Interrupted by user")
        }
        if let command = raw.firstMatch(of: #/<command-name>([^<]*)</command-name>[\s\S]*?(?:<command-args>([^<]*)</command-args>)?/#) {
            let text = "\(command.1) \(command.2 ?? "")".trimmingCharacters(in: .whitespacesAndNewlines)
            return Entry(id: id, ts: ts, kind: .system, text: text)
        }

        let text = raw.replacing(#/<pasted_content[^>]*>|</pasted_content>/#, with: "")
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images == nil { return nil }
        return Entry(id: id, ts: ts, kind: .user, text: text, images: images)
    }

    /// ToolSearch results only load tool schemas.
    private static func isToolSchemaResult(_ block: [String: Any]) -> Bool {
        guard let parts = block["content"] as? [Any], !parts.isEmpty else { return false }
        return parts.allSatisfy { ($0 as? [String: Any])?["type"] as? String == "tool_reference" }
    }

    private static func toolResult(_ id: String, _ ts: String, _ block: [String: Any]) -> Entry {
        var images: [ImageData] = []
        var text = ""
        if let content = block["content"] as? String {
            text = content
        } else if let parts = block["content"] as? [Any] {
            for case let part as [String: Any] in parts {
                if part["type"] as? String == "text", let partText = part["text"] as? String {
                    text += (text.isEmpty ? "" : "\n") + partText
                } else if part["type"] as? String == "image" {
                    addImage(&images, part)
                }
            }
        }
        if text.utf16.count > maxToolResultChars {
            text = "\(utf16Prefix(text, maxToolResultChars))\n… (\(text.utf16.count - maxToolResultChars) characters truncated)"
        }
        return Entry(
            id: id, ts: ts, kind: .toolResult, text: text, images: images.isEmpty ? nil : images,
            toolUseId: block["tool_use_id"] as? String ?? "", isError: block["is_error"] as? Bool == true)
    }

    private static func addImage(_ images: inout [ImageData], _ block: [String: Any]) {
        guard let source = block["source"] as? [String: Any], source["type"] as? String == "base64",
            let data = source["data"] as? String, data.count <= maxImageBase64
        else { return }
        images.append(ImageData(mediaType: source["media_type"] as? String ?? "image/png", data: data))
    }
}
