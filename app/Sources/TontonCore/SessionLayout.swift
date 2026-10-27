import Foundation

/// A block of the notch's session list.
public struct SessionSection: Equatable, Sendable {
    public enum Kind: Hashable, Sendable {
        case pinned
        /// Projects the user tagged, for a client or a topic, whatever machine they run on.
        case tag(String)
        case thisMac
        case machine(String)
    }

    public let kind: Kind
    public let sessions: [SessionSummary]

    /// Pinned sessions and tags gather several machines: each row then says which.
    public var mixesMachines: Bool {
        switch kind {
        case .pinned, .tag: true
        case .thisMac, .machine: false
        }
    }
}

/// How the notch lists sessions: pinned ones first, in the order they were pinned, then one group per tag, then this Mac's,
/// then one group per machine, tags and machines with a live session first. ⌘1…⌘9 and ⌘↑↓ follow the same order, so
/// pinned sessions keep their shortcut.
public enum SessionLayout {
    /// `thisMac` holds the machine ids of this Mac: its agent's, and the one of sessions read from its files. `tags` gives
    /// the tag of each tagged project.
    public static func sections(
        _ sessions: [SessionSummary], pinned: [String], thisMac: Set<String> = [], tags: [String: String] = [:]
    ) -> [SessionSection] {
        let pinnedSessions = pinned.compactMap { id in sessions.first { $0.id == id } }
        let unpinned = sessions.filter { !pinned.contains($0.id) }
        let tagged = Dictionary(grouping: unpinned.filter { tags[$0.project] != nil }) { tags[$0.project] ?? "" }
        let tagSections = livelyFirst(tagged).map { SessionSection(kind: .tag($0), sessions: tagged[$0, default: []]) }
        let untagged = unpinned.filter { tags[$0.project] == nil }
        let local = untagged.filter { thisMac.contains($0.machineId) }
        let rest = untagged.filter { !thisMac.contains($0.machineId) }
        let groups = Dictionary(grouping: rest, by: \.machine)
        let machineSections = livelyFirst(groups).map { SessionSection(kind: .machine($0), sessions: groups[$0, default: []]) }
        return (pinnedSessions.isEmpty ? [] : [SessionSection(kind: .pinned, sessions: pinnedSessions)]) + tagSections
            + (local.isEmpty ? [] : [SessionSection(kind: .thisMac, sessions: local)]) + machineSections
    }

    public static func ordered(
        _ sessions: [SessionSummary], pinned: [String], thisMac: Set<String> = [], tags: [String: String] = [:]
    ) -> [SessionSummary] {
        sections(sessions, pinned: pinned, thisMac: thisMac, tags: tags).flatMap(\.sessions)
    }

    /// Group names, the ones with a live session first, then by name.
    private static func livelyFirst(_ groups: [String: [SessionSummary]]) -> [String] {
        groups.keys.sorted { a, b in
            let liveA = groups[a, default: []].contains { $0.status.isLive }
            let liveB = groups[b, default: []].contains { $0.status.isLive }
            return liveA != liveB ? liveA : a.localizedCaseInsensitiveCompare(b) == .orderedAscending
        }
    }
}

/// The tags of Settings, one per project: a client or a topic the list groups sessions by.
public enum ProjectTags {
    /// Trimmed and short. Empty means no tag.
    public static func clean(_ tag: String) -> String {
        String(tag.trimmingCharacters(in: .whitespacesAndNewlines).prefix(24))
    }

    /// Every tag in use, by name.
    public static func names(_ tags: [String: String]) -> [String] {
        Set(tags.values).sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }
}
