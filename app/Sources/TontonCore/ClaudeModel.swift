import Foundation

/// The models `/model` switches a session to, by the aliases it takes: each stands for the latest model of its family.
public enum ModelFamily: String, Codable, CaseIterable, Sendable {
    case opus, sonnet, haiku

    public var label: String { rawValue.capitalized }
}

/// Claude Code names models by their API id. The notch shows them the way Claude Code's own menu does.
public enum ModelName {
    /// "Opus 4.5" for `claude-opus-4-5-20251101`, with a provider's prefix or suffix too (`us.anthropic.…-v1:0`,
    /// `…@20251001`), and "Sonnet 3.5" for the older `claude-3-5-sonnet-20241022`. Other models keep their id.
    public static func display(_ id: String) -> String {
        if let family = ModelFamily(rawValue: id.lowercased()) { return family.label }
        guard let parts = parts(id) else { return id }
        return "\(parts.name.capitalized) \(parts.version.joined(separator: "."))"
    }

    public static func family(_ id: String) -> ModelFamily? {
        ModelFamily(rawValue: id.lowercased()) ?? parts(id).flatMap { ModelFamily(rawValue: $0.name) }
    }

    private static func parts(_ id: String) -> (name: String, version: [String])? {
        guard let start = id.range(of: "claude-", options: .caseInsensitive) else { return nil }
        // `[1m]` asks for a million tokens of context, `@date` and `:0` come from cloud providers.
        let rest = id[start.upperBound...].lowercased().prefix { !"[@:".contains($0) }
        var tokens = rest.split(separator: "-").map(String.init)
        if let last = tokens.last, last.hasPrefix("v"), Int(last.dropFirst()) != nil { tokens.removeLast() }
        if let last = tokens.last, last.count == 8, Int(last) != nil { tokens.removeLast() }
        let words = tokens.filter { Int($0) == nil }
        let version = tokens.filter { Int($0) != nil }
        guard words.count == 1, let name = words.first, !version.isEmpty, version.allSatisfy({ $0.count <= 2 }) else { return nil }
        return (name, version)
    }
}
