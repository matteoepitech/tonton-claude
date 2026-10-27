import Foundation

/// Where a conversation stands while it loads, so the notch says it instead of showing nothing. A relay session's history
/// comes in two when the relay can: its latest entries first, then all of it.
public enum ConversationLoad: Equatable, Sendable {
    case loaded
    /// Nothing to show yet: the relay's history is on its way.
    case loading
    /// The latest entries show, the earlier ones are on their way.
    case loadingEarlier

    /// `relayEntries` is nil until a history came; `localEntries` counts what this Mac's own files already show of it.
    public static func state(
        relaySession: Bool, reachable: Bool, relayEntries: [Entry]?, partial: Bool, localEntries: Int
    ) -> ConversationLoad {
        // This Mac's transcript shows the whole conversation while the relay's copy comes.
        guard relaySession, reachable, localEntries == 0 else { return .loaded }
        if partial { return .loadingEarlier }
        return relayEntries == nil ? .loading : .loaded
    }

    /// The latest entries replace what shows only when nothing whole does: after a reconnection, the conversation already
    /// there stays until the whole history replaces it.
    public static func takesRecent(current: [Entry]?, partial: Bool) -> Bool {
        current == nil || partial
    }
}
