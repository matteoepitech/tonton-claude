import Foundation

// The leaderboard of a cluster as the notch follows it (docs/cluster.md, The leaderboard): the members who share their
// Tonton, ranked, and what sharing this member's hero would write. As `shareHero` in shared/cluster-watch.ts.

extension ClusterBoard {
    /// The members who share their Tonton; nil while the document is missing or does not open.
    public var leaderboard: ClusterLeaderboard? { state.flatMap(vault.leaderboard) }
    /// The revision a new board replaces: 0 while there is none.
    public var leaderboardRev: Int { state?.docs.first { $0.name == ClusterHeroes.document }?.rev ?? 0 }

    public func sharesHero(account: String) -> Bool { leaderboard?.heroes.contains { $0.account == account } ?? false }

    /// Every member, ranked; all of them without numbers while nobody shares.
    public func ranks(now: Date = Date()) -> [ClusterRank] {
        guard let state else { return [] }
        let members = state.members.map { (account: $0.account, joinedAt: $0.joinedAt) }
        return (leaderboard ?? ClusterLeaderboard()).ranked(members, clockStartedAt: clock?.startedAt, now: now)
    }

    /// The members' level-ups for the feed, newest first.
    public var levelUps: [ClusterLevelUpLine] {
        ClusterHeroes.levelUps(leaderboard, members: state?.members.map(\.account) ?? [])
    }

    public enum HeroShare: Equatable, Sendable {
        /// The board already says it.
        case unchanged
        /// The board exists but does not open with the keys held: writing it would drop every other member.
        case unreadable
        /// This account is not a member, or the cluster is not open yet.
        case notOpen
        /// The board to seal and write over `rev`.
        case write(rev: Int, board: ClusterLeaderboard)
    }

    /// What putting `hero` on the board (nil: taking it off) would write for `account`: only its own entry changes.
    public func share(_ hero: RPG.State?, account: String, now: Date = Date()) -> HeroShare {
        guard let state, let me = state.members.first(where: { $0.account == account }) else { return .notOpen }
        let exists = state.docs.contains { $0.name == ClusterHeroes.document }
        let board = leaderboard
        if exists && board == nil { return .unreadable }
        let previous = board?.heroes.first { $0.account == account }
        let from = ClusterHeroes.from(clockStartedAt: clock?.startedAt, joinedAt: me.joinedAt)
        let entry = hero.map { ClusterHero(hero: $0, account: account, from: from, previous: previous, now: now) }
        switch (previous, entry) {
        case (nil, nil): return .unchanged
        case (let previous?, let entry?) where previous.same(as: entry): return .unchanged
        default: return .write(rev: leaderboardRev, board: (board ?? ClusterLeaderboard()).with(entry, for: account))
        }
    }
}
