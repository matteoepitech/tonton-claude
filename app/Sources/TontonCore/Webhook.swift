import Foundation

/// A chat webhook (Discord, Slack or anything that takes JSON) told when a session finishes or waits for the user.
/// By default the message says only what happened: no project, no machine, nothing from the conversation.
public enum Webhook {
    public enum Event: Sendable {
        case finished, needsYou
    }

    public struct Privacy: Equatable, Sendable {
        public var includeNames: Bool
        public var includeLastMessage: Bool

        public init(includeNames: Bool = false, includeLastMessage: Bool = false) {
            self.includeNames = includeNames
            self.includeLastMessage = includeLastMessage
        }
    }

    public static func message(_ event: Event, _ session: SessionSummary, privacy: Privacy) -> String {
        let (name, machine) = (session.displayName, session.machine)
        let status = session.status.label.lowercased(with: Strings.locale)
        var text =
            switch (event, privacy.includeNames) {
            case (.finished, true): String(core: "Claude (\(name) on \(machine)) finished.")
            case (.finished, false): String(core: "A Claude session finished.")
            case (.needsYou, true): String(core: "Claude (\(name) on \(machine)) needs you: \(status).")
            case (.needsYou, false): String(core: "A Claude session needs you: \(status).")
            }
        if privacy.includeLastMessage, let last = session.lastMessage?.trimmingCharacters(in: .whitespacesAndNewlines), !last.isEmpty {
            text += "\n> \(last.prefix(300))"
        }
        return text
    }

    /// The JSON body: Discord reads `content`, Slack reads `text`, other services get both.
    public static func body(for url: URL, message: String) -> Data {
        let host = url.host?.lowercased() ?? ""
        let fields: [String: String] =
            if host.hasSuffix("discord.com") || host.hasSuffix("discordapp.com") {
                ["content": message]
            } else if host.hasSuffix("slack.com") {
                ["text": message]
            } else {
                ["text": message, "content": message]
            }
        return (try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])) ?? Data()
    }

    /// Only https URLs are sent to, so nothing about the user's sessions goes out in clear text.
    public static func url(_ text: String) -> URL? {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)), url.scheme == "https", url.host != nil
        else { return nil }
        return url
    }
}
