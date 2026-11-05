import Foundation

/// A chat webhook (Discord, Slack or anything that takes JSON) told when a session finishes or waits for the user.
/// Discord gets an embed and Slack blocks, with the facts as fields; other services one plain message. By default a post
/// says what happened, the tool, the model, how long the turn took and what the session cost: no project, no machine,
/// nothing from the conversation. Names and Claude's answer, with the links it gives, are each the user's choice.
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

    /// What a post says, whatever the service shows it as.
    public struct Post: Equatable, Sendable {
        public struct Field: Equatable, Sendable {
            public let name: String
            public let value: String
            /// Side by side with the others, as Discord lays them out; long values take a line of their own.
            public let inline: Bool

            public init(_ name: String, _ value: String, inline: Bool = true) {
                self.name = name
                self.value = value
                self.inline = inline
            }
        }

        public struct Link: Equatable, Sendable {
            public let label: String
            public let url: URL

            /// A Claude artifact: what the embed's title opens.
            public var isArtifact: Bool {
                let host = url.host?.lowercased() ?? ""
                return ["claude.ai", "claude.site"].contains { host == $0 || host.hasSuffix(".\($0)") } && url.path.contains("artifact")
            }
        }

        public var title: String
        /// Above the title: the tool, and the machine when names are allowed.
        public var author: String?
        /// The start of Claude's answer, as Markdown.
        public var excerpt: String?
        public var color: Int
        public var fields: [Field]
        /// Claude artifacts and pull requests the answer gives.
        public var links: [Link]
        public var date: Date

        /// The whole post as one plain message, for the services that only show text.
        public var text: String {
            var lines = [author.map { "\($0): \(title)" } ?? title]
            if !fields.isEmpty { lines.append(fields.map { "\($0.name): \($0.value)" }.joined(separator: " · ")) }
            if let excerpt { lines.append(Webhook.quoted(excerpt)) }
            lines += links.map { "\($0.label): \($0.url.absoluteString)" }
            return lines.joined(separator: "\n")
        }
    }

    static let green = 0x3FB950
    static let amber = 0xE3A008
    static let red = 0xE5534B
    static let accent = 0x7C6CF2

    public static func post(
        _ event: Event, _ session: SessionSummary, privacy: Privacy, reply: String? = nil, now: Date = Date()
    ) -> Post {
        let name = session.displayName
        let title =
            switch (event, privacy.includeNames) {
            case (.finished, true): String(core: "\(name) finished")
            case (.finished, false): String(core: "A session finished")
            case (.needsYou, true): String(core: "\(name) needs you")
            case (.needsYou, false): String(core: "A session needs you")
            }
        var fields: [Post.Field] = []
        if event == .needsYou { fields.append(.init(String(core: "Status"), session.displayStatusText)) }
        if privacy.includeNames {
            // The title has the project already, unless the user named the session.
            if session.name != nil { fields.append(.init(String(core: "Project"), session.project)) }
            if let branch = session.branch, !branch.isEmpty { fields.append(.init(String(core: "Branch"), "`\(branch)`")) }
        }
        if let model = session.modelName { fields.append(.init(String(core: "Model"), model)) }
        // The turn that just ended, once the agent has told it.
        if event == .finished, let turn = session.turns?.last, now.timeIntervalSince(turn.end) < 600 {
            fields.append(.init(String(core: "Worked"), duration(turn.seconds)))
        }
        if let tasks = session.tasks { fields.append(.init(String(core: "Tasks"), String(core: "\(tasks.done) of \(tasks.total) done"))) }
        if let cost = session.costUSD, cost >= 0.01 { fields.append(.init(String(core: "Session cost"), String(format: "$%.2f", cost))) }
        if event == .needsYou, privacy.includeLastMessage, let ask = session.pendingPermissions.first {
            let input = ask.inputPreview.trimmingCharacters(in: .whitespacesAndNewlines)
            let value = input.isEmpty ? ask.toolName : "\(ask.toolName)\n```\n\(cut(input, 300))\n```"
            fields.append(.init(String(core: "Asks to use"), value, inline: false))
        }
        let answer = privacy.includeLastMessage ? (reply ?? session.lastMessage) : nil
        return Post(
            title: title,
            author: privacy.includeNames ? String(core: "\(session.codingTool.label) on \(session.machine)") : session.codingTool.label,
            excerpt: answer.flatMap(excerpt),
            color: event == .finished ? green : session.status == .error ? red : amber,
            fields: fields,
            links: answer.map(links) ?? [],
            date: now)
    }

    /// The post of the Test button.
    public static func test(now: Date = Date()) -> Post {
        Post(
            title: String(core: "Tonton Claude will post here."), author: nil, excerpt: nil, color: accent, fields: [], links: [],
            date: now)
    }

    /// The JSON body: an embed for Discord, blocks for Slack, `text` and `content` for the rest.
    public static func body(for url: URL, post: Post) -> Data {
        let host = url.host?.lowercased() ?? ""
        let fields: [String: Any] =
            if host.hasSuffix("discord.com") || host.hasSuffix("discordapp.com") {
                discord(post)
            } else if host.hasSuffix("slack.com") {
                slack(post)
            } else {
                ["text": post.text, "content": post.text]
            }
        return (try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])) ?? Data()
    }

    /// Only https URLs are sent to, so nothing about the user's sessions goes out in clear text.
    public static func url(_ text: String) -> URL? {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)), url.scheme == "https", url.host != nil
        else { return nil }
        return url
    }

    // MARK: The services

    /// Tonton's icon, as the repository publishes it.
    static let icon = "https://raw.githubusercontent.com/matteoepitech/tonton-claude/main/.github/assets/icon.png"

    /// Discord's limits: 256 for a title or a field's name, 1,024 for its value, 4,096 for the description, 25 fields.
    static func discord(_ post: Post) -> [String: Any] {
        var embed: [String: Any] = [
            "title": cut(post.title, 256),
            "color": post.color,
            "timestamp": ISO8601DateFormatter().string(from: post.date),
            "footer": ["text": "Tonton Claude", "icon_url": icon],
        ]
        if let author = post.author { embed["author"] = ["name": cut(author, 256)] }
        if let excerpt = post.excerpt { embed["description"] = cut(excerpt, 4096) }
        if let artifact = post.links.first(where: \.isArtifact) { embed["url"] = artifact.url.absoluteString }
        var fields = post.fields.map { ["name": cut($0.name, 256), "value": cut($0.value, 1024), "inline": $0.inline] as [String: Any] }
        if !post.links.isEmpty {
            let value = post.links.map { "[\(bracketed($0.label))](\($0.url.absoluteString))" }.joined(separator: "\n")
            fields.append(["name": String(core: "Links"), "value": cut(value, 1024), "inline": false])
        }
        if !fields.isEmpty { embed["fields"] = Array(fields.prefix(25)) }
        return ["username": "Tonton Claude", "avatar_url": icon, "embeds": [embed]]
    }

    /// Slack's limits: 150 for a header, 3,000 for a section, 10 fields of 2,000.
    static func slack(_ post: Post) -> [String: Any] {
        var blocks: [[String: Any]] = []
        if let author = post.author { blocks.append(["type": "context", "elements": [["type": "mrkdwn", "text": escaped(author)]]]) }
        blocks.append(["type": "header", "text": ["type": "plain_text", "text": cut(post.title, 150)]])
        if let excerpt = post.excerpt {
            blocks.append(["type": "section", "text": ["type": "mrkdwn", "text": cut(quoted(escaped(excerpt)), 3000)]])
        }
        if !post.fields.isEmpty {
            let fields = post.fields.prefix(10).map {
                ["type": "mrkdwn", "text": cut("*\(escaped($0.name))*\n\(escaped($0.value))", 2000)]
            }
            blocks.append(["type": "section", "fields": Array(fields)])
        }
        if !post.links.isEmpty {
            let text = post.links.map { "<\($0.url.absoluteString)|\(escaped($0.label))>" }.joined(separator: "\n")
            blocks.append(["type": "section", "text": ["type": "mrkdwn", "text": cut(text, 3000)]])
        }
        blocks.append(["type": "context", "elements": [["type": "mrkdwn", "text": "Tonton Claude"]]])
        return ["text": post.text, "blocks": blocks]
    }

    // MARK: Claude's answer

    /// The start of the answer: about 700 characters, cut between words, a code block left open closed again. Long dashes
    /// become plain ones.
    static func excerpt(_ text: String) -> String? {
        var text = text.replacingOccurrences(of: "\u{2014}", with: "-").replacingOccurrences(of: "\u{2013}", with: "-")
        text = text.replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if text.count > 700 {
            let head = text.prefix(700)
            let end = head.lastIndex(where: \.isWhitespace) ?? head.endIndex
            text = String(head[..<end]).trimmingCharacters(in: .whitespacesAndNewlines) + "…"
        }
        if text.components(separatedBy: "```").count.isMultiple(of: 2) { text += "\n```" }
        return text
    }

    /// Claude artifacts and GitHub pull requests in the answer, artifacts first, each once; five at most.
    static func links(_ text: String) -> [Post.Link] {
        var found: [(label: String?, url: URL)] = []
        let range = NSRange(text.startIndex..., in: text)
        let markdown = try? NSRegularExpression(pattern: #"\[([^\]\n]{1,100})\]\((https://[^\s)]+)\)"#)
        for match in markdown?.matches(in: text, range: range) ?? [] {
            guard let label = Range(match.range(at: 1), in: text), let address = Range(match.range(at: 2), in: text),
                let url = URL(string: String(text[address]))
            else { continue }
            found.append((String(text[label]), url))
        }
        let bare = try? NSRegularExpression(pattern: #"https://[^\s<>()\[\]"'`]+"#)
        for match in bare?.matches(in: text, range: range) ?? [] {
            guard let address = Range(match.range, in: text) else { continue }
            let trimmed = String(text[address]).trimmingCharacters(in: CharacterSet(charactersIn: ".,;:!?*_"))
            if let url = URL(string: trimmed) { found.append((nil, url)) }
        }
        var seen = Set<String>()
        var artifacts: [Post.Link] = []
        var pulls: [Post.Link] = []
        for (label, url) in found where seen.insert(url.absoluteString).inserted {
            let artifact = Post.Link(label: label ?? String(core: "Claude artifact"), url: url)
            if artifact.isArtifact {
                artifacts.append(artifact)
            } else if url.host?.lowercased() == "github.com", let number = url.path.firstMatch(of: #/^/[^/]+/[^/]+/pull/(\d+)/#)?.1 {
                pulls.append(.init(label: label ?? String(core: "Pull request #\(String(number))"), url: url))
            }
        }
        return Array((artifacts + pulls).prefix(5))
    }

    /// "45 s", "12 min", "1 h 05 min".
    static func duration(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds.rounded()))
        if total < 60 { return String(core: "\(total) s") }
        let minutes = total / 60
        if minutes < 60 { return String(core: "\(minutes) min") }
        return String(core: "\(minutes / 60) h \(String(format: "%02d", minutes % 60)) min")
    }

    static func cut(_ text: String, _ limit: Int) -> String {
        text.count <= limit ? text : String(text.prefix(limit - 1)) + "…"
    }

    static func quoted(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false).map { "> \($0)" }.joined(separator: "\n")
    }

    /// A label inside Discord's link brackets.
    static func bracketed(_ text: String) -> String {
        text.replacingOccurrences(of: "[", with: "(").replacingOccurrences(of: "]", with: ")")
    }

    /// The three characters Slack's mrkdwn wants escaped.
    static func escaped(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(
            of: ">", with: "&gt;")
    }
}
