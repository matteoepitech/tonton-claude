import Foundation

/// What's new after an update: the release notes of the version the app now runs, shown once per version.
public enum WhatsNew {
    public enum Launch: Equatable, Sendable {
        /// Fetch the notes and show them, then record the version.
        case show
        /// Nothing to show for this version: remember it, so the next update compares with it.
        case record
        case nothing
    }

    /// After an update only. A fresh install has nothing new to show, and neither has a build that isn't a release, like
    /// `swift run`. `shown` is the version whose notes were last shown or recorded, `ranBefore` whether the app ran before
    /// this launch: versions from before this feature kept no `shown`.
    public static func atLaunch(current: String?, shown: String, ranBefore: Bool, enabled: Bool) -> Launch {
        guard let current, isRelease(current) else { return .nothing }
        let newer = shown.isEmpty ? ranBefore : shown.compare(current, options: .numeric) == .orderedAscending
        if newer && enabled { return .show }
        return shown.isEmpty || shown.compare(current, options: .numeric) == .orderedAscending ? .record : .nothing
    }

    /// GitHub's API for the release of a version, which the release workflow tags `v<version>`.
    public static func releaseURL(for version: String) -> URL? {
        guard isRelease(version) else { return nil }
        return URL(string: "https://api.github.com/repos/matteoepitech/tonton-claude/releases/tags/v\(version)")
    }

    /// What GitHub said about a release.
    public enum Answer: Equatable, Sendable {
        case notes(Release)
        /// No such release, or one without notes: asking again won't help.
        case none
        /// Offline, rate limited or down: worth another try at the next launch.
        case unreachable

        public init(status: Int?, data: Data) {
            switch status {
            case 200: self = Release.decode(data).map(Answer.notes) ?? .none
            case 404: self = .none
            default: self = .unreachable
            }
        }
    }

    public struct Release: Decodable, Equatable, Sendable {
        public let body: String
        public let page: URL

        public init(body: String, page: URL) {
            self.body = body
            self.page = page
        }

        enum CodingKeys: String, CodingKey { case body, page = "html_url" }

        /// Nil for anything but a release with notes.
        public static func decode(_ data: Data) -> Release? {
            guard let release = try? JSONDecoder().decode(Release.self, from: data),
                !release.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { return nil }
            return release
        }
    }

    /// The notes as the notch's Markdown shows them: it reads inline styles and headings only, so list items get a bullet,
    /// and GitHub's line endings go. A first "What's new" heading, or the "What's Changed" of generated notes, would repeat
    /// the window's title.
    static let titleHeading = #"^\s*#+\s*What['’]s (new|changed)\s*(\n|$)"#

    public static func readable(_ body: String) -> String {
        body.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: Self.titleHeading, with: "", options: [.regularExpression, .caseInsensitive])
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { line in
                guard let marker = line.range(of: #"^\s*[-*]\s+"#, options: .regularExpression) else { return String(line) }
                let indent = line.prefix { $0 == " " }.count
                return String(repeating: " ", count: indent) + "• " + line[marker.upperBound...]
            }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// `1.2.3`, the versions releases carry. Not `dev`, nor the `0.0.0` of a build made without tags.
    public static func isRelease(_ version: String) -> Bool {
        version != "0.0.0" && version.range(of: #"^\d+\.\d+\.\d+$"#, options: .regularExpression) != nil
    }
}
