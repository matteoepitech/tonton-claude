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

/// One task of the list Claude Code's TodoWrite (or OpenCode's todowrite) keeps.
public struct TodoItem: Codable, Equatable, Sendable {
    public enum Status: String, Sendable { case pending, inProgress = "in_progress", completed, cancelled }

    public let content: String
    /// As sent: `cancelled` comes from OpenCode only, and a value this app does not know reads as pending.
    let status: String
    /// What Claude Code shows while the task runs: "Running the tests".
    public let activeForm: String?

    public var state: Status { Status(rawValue: status) ?? .pending }

    public init(content: String, status: Status, activeForm: String? = nil) {
        self.content = content
        self.status = status.rawValue
        self.activeForm = activeForm
    }
}

public enum EntryKind: String, Codable, Sendable {
    case user, assistant, tool, system
    case toolResult = "tool_result"
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
    /// The task list a TodoWrite call sets, from agents that send it.
    public var todos: [TodoItem]?

    public init(
        id: String, ts: String, kind: EntryKind, text: String? = nil, images: [ImageData]? = nil, viaNotch: Bool? = nil,
        toolUseId: String? = nil, name: String? = nil, summary: String? = nil, isError: Bool? = nil, edits: [FileEdit]? = nil,
        todos: [TodoItem]? = nil
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
        self.todos = todos
    }

    /// The file a Read, Write or Edit call works on, when its summary holds the whole absolute path. The agent cuts long
    /// summaries with "…", and paths from Windows machines never exist on the Mac.
    public var filePath: String? {
        guard kind == .tool, let name, Self.fileTools.contains(name), let summary, summary.hasPrefix("/"), !summary.hasSuffix("…")
        else { return nil }
        return summary
    }

    private static let fileTools: Set = ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]

    /// A TodoWrite call that carries its list.
    public var isTodoList: Bool { kind == .tool && name == "TodoWrite" && todos != nil }
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
        // A task list shows as the checklist (`TodoList.latest`), not as a row per update.
        return entries.filter { !$0.isTodoList }.compactMap { entry in
            switch entry.kind {
            case .user: .user(entry)
            case .assistant: .assistant(entry)
            case .system: .system(entry)
            case .tool: .tool(call: entry, result: entry.toolUseId.flatMap { results[$0] })
            case .toolResult: nil
            }
        }
    }
}
