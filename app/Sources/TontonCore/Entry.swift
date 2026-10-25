import Foundation

public struct ImageData: Codable, Equatable, Sendable {
    public let mediaType: String
    public let data: String

    public init(mediaType: String, data: String) {
        self.mediaType = mediaType
        self.data = data
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

    public init(
        id: String, ts: String, kind: EntryKind, text: String? = nil, images: [ImageData]? = nil, viaNotch: Bool? = nil,
        toolUseId: String? = nil, name: String? = nil, summary: String? = nil, isError: Bool? = nil
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
    }
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
            case .toolResult: nil
            }
        }
    }
}
