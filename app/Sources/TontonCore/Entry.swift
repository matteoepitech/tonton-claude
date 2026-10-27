import Foundation

public struct ImageData: Codable, Equatable, Sendable {
    public let mediaType: String
    public let data: String

    public init(mediaType: String, data: String) {
        self.mediaType = mediaType
        self.data = data
    }
}

/// A text replacement of an Edit or MultiEdit call, cut by the agent when it is long.
public struct FileEdit: Codable, Equatable, Sendable {
    public let oldText: String
    public let newText: String

    public init(oldText: String, newText: String) {
        self.oldText = oldText
        self.newText = newText
    }
}

public enum EntryKind: String, Codable, Sendable {
    case user, assistant, tool, system
    case toolResult = "tool_result"
    /// A call of a subagent, and its result, under the Task call that started it (`parent`).
    case subagentTool = "sub_tool"
    case subagentResult = "sub_result"

    public var isSubagent: Bool { self == .subagentTool || self == .subagentResult }
}

/// One element of a conversation, as produced by the agent's transcript parser.
public struct Entry: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let ts: String
    public let kind: EntryKind
    public var text: String?
    public var images: [ImageData]?
    public var viaNotch: Bool?
    public var toolUseId: String?
    public var name: String?
    public var summary: String?
    public var isError: Bool?
    /// Edit and MultiEdit calls, from agents that send them.
    public var edits: [FileEdit]?
    /// For a subagent's call or result: the Task call that started the subagent.
    public var parent: String?

    public init(
        id: String, ts: String, kind: EntryKind, text: String? = nil, images: [ImageData]? = nil, viaNotch: Bool? = nil,
        toolUseId: String? = nil, name: String? = nil, summary: String? = nil, isError: Bool? = nil, edits: [FileEdit]? = nil,
        parent: String? = nil
    ) {
        self.id = id
        self.ts = ts
        self.kind = kind
        self.text = text
        self.images = images
        self.viaNotch = viaNotch
        self.toolUseId = toolUseId
        self.name = name
        self.summary = summary
        self.isError = isError
        self.edits = edits
        self.parent = parent
    }

    /// The file a Read, Write or Edit call works on, when its summary holds the whole absolute path. The agent cuts long
    /// summaries with "…", and paths from Windows machines never exist on the Mac.
    public var filePath: String? {
        guard kind == .tool, let name, Self.fileTools.contains(name), let summary, summary.hasPrefix("/"), !summary.hasSuffix("…")
        else { return nil }
        return summary
    }

    private static let fileTools: Set = ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]
}

/// What the chat view renders: tool calls are merged with their result.
public enum ChatItem: Identifiable, Equatable, Sendable {
    case user(Entry)
    case assistant(Entry)
    case tool(call: Entry, result: Entry?)
    case system(Entry)

    public var id: String {
        switch self {
        case .user(let entry), .assistant(let entry), .system(let entry): entry.id
        case .tool(let call, _): call.id
        }
    }

    public static func build(from entries: [Entry]) -> [ChatItem] {
        let results = Dictionary(
            entries.filter { $0.kind == .toolResult }.compactMap { entry in entry.toolUseId.map { ($0, entry) } },
            uniquingKeysWith: { _, latest in latest }
        )
        return entries.compactMap { entry in
            switch entry.kind {
            case .user: .user(entry)
            case .assistant: .assistant(entry)
            case .system: .system(entry)
            case .tool: .tool(call: entry, result: entry.toolUseId.flatMap { results[$0] })
            case .toolResult, .subagentTool, .subagentResult: nil
            }
        }
    }

    /// The calls of the subagents, with their results, in order, by the Task call that started them.
    public static func subagentSteps(in entries: [Entry]) -> [String: [(call: Entry, result: Entry?)]] {
        let results = Dictionary(
            entries.filter { $0.kind == .subagentResult }.compactMap { entry in entry.toolUseId.map { ($0, entry) } },
            uniquingKeysWith: { _, latest in latest }
        )
        var steps: [String: [(call: Entry, result: Entry?)]] = [:]
        for entry in entries where entry.kind == .subagentTool {
            guard let parent = entry.parent else { continue }
            steps[parent, default: []].append((entry, entry.toolUseId.flatMap { results[$0] }))
        }
        return steps
    }
}
