import Foundation

/// Sections of the session list the user folded: a machine, This Mac, a tag or the pinned sessions. A folded section keeps
/// its header, with how many sessions it hides and whether one needs the user; its sessions leave the list and the
/// keyboard's ⌘1…⌘9 and ⌘↑↓. A search shows every match, folded or not.
public enum SessionFolding {
    /// The same across launches: machines and tags by name, as the list groups them.
    public static func key(_ kind: SessionSection.Kind) -> String {
        switch kind {
        case .pinned: "pinned"
        case .tag(let tag): "tag:\(tag)"
        case .thisMac: "thisMac"
        case .machine(let machine): "machine:\(machine)"
        }
    }

    public static func isFolded(_ section: SessionSection, in folded: Set<String>) -> Bool {
        folded.contains(key(section.kind))
    }

    public static func toggled(_ kind: SessionSection.Kind, in folded: Set<String>) -> Set<String> {
        let key = key(kind)
        return folded.contains(key) ? folded.subtracting([key]) : folded.union([key])
    }

    /// What a folded header says about the sessions it hides.
    public struct Summary: Equatable, Sendable {
        public let hidden: Int
        /// The most pressing status among them that needs the user: a request first, then an error, then a question.
        public let attention: SessionStatus?
    }

    public static func summary(_ sessions: [SessionSummary]) -> Summary {
        let statuses = Set(sessions.map(\.status))
        let attention = [SessionStatus.permission, .error, .waiting].first { statuses.contains($0) }
        return Summary(hidden: sessions.count, attention: attention)
    }

    /// The sessions the list shows, in its order: none from a folded section, unless a search is on.
    public static func shown(_ sections: [SessionSection], folded: Set<String>, searching: Bool = false) -> [SessionSummary] {
        sections.flatMap { searching || !isFolded($0, in: folded) ? $0.sessions : [] }
    }
}
