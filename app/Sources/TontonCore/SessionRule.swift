import Foundation

/// "Allow for this session" on a permission card: which calls it lets through until the session ends, made from the call
/// the user just allowed. A command allows its first words and what follows them, a web page its site, other tools any of
/// their calls. Mirrors shared/session-rule.ts; both check shared/test/session-rules.json.
public struct SessionRule: Equatable, Sendable {
    /// `npm test`, `github.com`, `Edit`.
    public let label: String
    public let rules: [PermissionRule]

    /// Nil when no rule is safe to offer: then the card has no such button.
    public static func suggested(tool: String, inputPreview: String) -> SessionRule? {
        guard !tool.isEmpty else { return nil }
        // A preview cut short: only tools without a pattern can be allowed.
        let input = (try? JSONSerialization.jsonObject(with: Data(inputPreview.utf8))) as? [String: Any] ?? [:]
        if tool == "Bash" || tool == "PowerShell" {
            let command = (input["command"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !command.isEmpty else { return nil }
            // A chained command is only ever allowed exactly as it is. Shell syntax as the agent matches it (agent/src/rules.ts).
            if command.contains(#/[;&|`<>\n\r]|\$\(/#) {
                return SessionRule(label: command, rules: [PermissionRule(tool: tool, pattern: command)])
            }
            let words = command.split(whereSeparator: \.isWhitespace).map(String.init)
            // A second word that is a subcommand (`npm test`, `git status`), not an argument (`ls -la`, `cat ./x`).
            let prefix =
                words.count > 1 && words[1].wholeMatch(of: #/[A-Za-z][A-Za-z0-9_:-]*/#) != nil ? "\(words[0]) \(words[1])" : words[0]
            return SessionRule(
                label: prefix, rules: [PermissionRule(tool: tool, pattern: prefix), PermissionRule(tool: tool, pattern: "\(prefix) *")])
        }
        if tool == "WebFetch" {
            guard let text = input["url"] as? String, let url = URL(string: text), let scheme = url.scheme, let host = url.host,
                ["http", "https"].contains(scheme.lowercased())
            else { return nil }
            let port = url.port.map { ":\($0)" } ?? ""
            let origin = "\(scheme.lowercased())://\(host.lowercased())\(port)"
            return SessionRule(
                label: "\(host.lowercased())\(port)",
                rules: [PermissionRule(tool: tool, pattern: origin), PermissionRule(tool: tool, pattern: "\(origin)/*")])
        }
        return SessionRule(label: tool, rules: [PermissionRule(tool: tool, pattern: nil)])
    }
}

/// What the app seals with the verdict, bound to its session and request so the relay cannot hand it to another session.
struct SessionRules: Codable {
    let sessionId: String
    let requestId: String
    let rules: [PermissionRule]
}
