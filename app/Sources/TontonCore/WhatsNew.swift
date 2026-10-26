import Foundation

/// What's new after an update: the release notes of the version the app now runs, shown once per version.
public enum WhatsNew {
    /// After an update only. A fresh install has nothing new to show, and neither has a build without a version, like
    /// `swift run`. `shown` is the version whose notes were last shown, `ranBefore` whether the app ran before this launch:
    /// versions from before this feature kept no `shown`.
    public static func shouldShow(current: String?, shown: String?, ranBefore: Bool) -> Bool {
        guard let current, isRelease(current) else { return false }
        guard let shown, !shown.isEmpty else { return ranBefore }
        return shown.compare(current, options: .numeric) == .orderedAscending
    }

    /// GitHub's API for the release of a version, which the release workflow tags `v<version>`.
    public static func releaseURL(for version: String) -> URL? {
        guard isRelease(version) else { return nil }
        return URL(string: "https://api.github.com/repos/matteoepitech/tonton-claude/releases/tags/v\(version)")
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
    /// and GitHub's line endings go. A first "What's new" heading would repeat the window's title.
    public static func readable(_ body: String) -> String {
        body.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: #"^\s*#+\s*What['’]s new\s*\n"#, with: "", options: [.regularExpression, .caseInsensitive])
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
