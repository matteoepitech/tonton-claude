import Foundation

extension SessionSummary {
    /// The relay's sessions and those this Mac reads from its own files: Claude Code's transcripts, OpenCode's service,
    /// Codex's rollouts. Both copies of a session carry its tool's own id (for Codex, the `session_id` of its rollout, which
    /// the agent reports it under), so when an agent reports a session read here too, its copy wins: it can chat, and its
    /// history is the one other devices see. `dismissed` are local sessions removed from the list by hand.
    public static func merged(relay: [SessionSummary], local: [SessionSummary], dismissed: Set<String> = []) -> [SessionSummary] {
        let relayIds = Set(relay.map(\.id))
        return relay + local.filter { !relayIds.contains($0.id) && !dismissed.contains($0.id) }
    }
}
