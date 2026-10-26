import Foundation

/// A block of the notch's session list.
public struct SessionSection: Equatable, Sendable {
    public enum Kind: Hashable, Sendable {
        case pinned
        case thisMac
        case machine(String)
    }

    public let kind: Kind
    public let sessions: [SessionSummary]
}

/// How the notch lists sessions: pinned ones first, in the order they were pinned, then this Mac's, then one group per
/// machine, machines with a live session first. ⌘1…⌘9 and ⌘↑↓ follow the same order, so pinned sessions keep their
/// shortcut.
public enum SessionLayout {
    public static func sections(_ sessions: [SessionSummary], pinned: [String], thisMac: String? = nil) -> [SessionSection] {
        let pinnedSessions = pinned.compactMap { id in sessions.first { $0.id == id } }
        let unpinned = sessions.filter { !pinned.contains($0.id) }
        let local = unpinned.filter { $0.machineId == thisMac }
        let rest = unpinned.filter { $0.machineId != thisMac }
        let groups = Dictionary(grouping: rest, by: \.machine)
        let machines = groups.keys.sorted { a, b in
            let liveA = groups[a, default: []].contains { $0.status.isLive }
            let liveB = groups[b, default: []].contains { $0.status.isLive }
            return liveA != liveB ? liveA : a.localizedCaseInsensitiveCompare(b) == .orderedAscending
        }
        let machineSections = machines.map { SessionSection(kind: .machine($0), sessions: groups[$0, default: []]) }
        return (pinnedSessions.isEmpty ? [] : [SessionSection(kind: .pinned, sessions: pinnedSessions)])
            + (local.isEmpty ? [] : [SessionSection(kind: .thisMac, sessions: local)]) + machineSections
    }

    public static func ordered(_ sessions: [SessionSummary], pinned: [String], thisMac: String? = nil) -> [SessionSummary] {
        sections(sessions, pinned: pinned, thisMac: thisMac).flatMap(\.sessions)
    }
}
