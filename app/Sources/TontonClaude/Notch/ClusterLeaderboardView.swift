import SwiftUI
import TontonCore

// The cluster's leaderboard in the notch (#316), as on the website: the members ranked by the XP their Tonton earned
// since the clock started, or since they joined, each with its Tonton, level and XP today. Sharing is each member's own
// choice; one who does not share is listed without numbers. ClusterStore keeps this member's entry up to date.

struct ClusterLeaderboardView: View {
    let board: ClusterBoard
    let account: String
    @ObservedObject private var clusters = ClusterStore.shared
    @ObservedObject private var rpg = RPGStore.shared

    var body: some View {
        let shared = clusters.sharesHero(in: board.id)
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Group {
                    if board.clock?.startedAt != nil { Text("XP since the clock started") } else { Text("XP since each member joined") }
                }
                .font(.notch(10, weight: .semibold))
                .foregroundStyle(Theme.tertiary)
                Spacer(minLength: 4)
                Button(shared ? String(localized: "Stop sharing my Tonton") : String(localized: "Share my Tonton here")) {
                    clusters.shareHero(!shared, in: board.id)
                }
                .font(.notch(10.5, weight: .semibold))
                .disabled(!shared && !rpg.ready)
                .help("Only the level, the look and the XP are shared, never what the work was.")
            }
            ClusterLeaderboardList(ranks: board.ranks(), account: account, names: names)
        }
    }

    private var names: [String: String] {
        guard let state = board.state else { return [:] }
        return Dictionary(
            state.members.map { ($0.account, ClusterModel.memberName(state, account: $0.account)) }, uniquingKeysWith: { first, _ in first }
        )
    }
}

/// The ranked members, with no store: what the tab shows, and what the renderer draws.
struct ClusterLeaderboardList: View {
    let ranks: [ClusterRank]
    let account: String
    /// Each member's name, by account.
    let names: [String: String]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(ranks, id: \.account) { rank in row(rank) }
        }
    }

    private func row(_ rank: ClusterRank) -> some View {
        let name = names[rank.account] ?? String(localized: "A member")
        return HStack(spacing: 8) {
            Text(verbatim: rank.rank.map(String.init) ?? "–")
                .font(.system(size: Theme.textSize.points(13), weight: .bold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(Theme.tertiary)
                .frame(minWidth: 18)
            HeroSprite(hero: Self.wearing(rank.hero?.equipped ?? [:]), pose: .idle, size: 32, animated: false)
                .opacity(rank.hero == nil ? 0.35 : 1)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 5) {
                    Text(verbatim: name).font(.notch(11.5, weight: .bold)).lineLimit(1)
                    if rank.account == account { PoolChip(text: String(localized: "You")) }
                }
                if let hero = rank.hero {
                    Text("Level \(hero.level) · \(RPG.title(level: hero.level))").font(.notch(10)).foregroundStyle(Theme.secondary)
                } else {
                    Text("Doesn't share its Tonton").font(.notch(10)).foregroundStyle(Theme.tertiary)
                }
            }
            Spacer(minLength: 6)
            if rank.hero != nil {
                VStack(alignment: .trailing, spacing: 1) {
                    Text("\(rank.since) XP").font(.notch(11.5, weight: .bold)).monospacedDigit()
                    Text("+\(rank.today) today").font(.notch(9.5)).monospacedDigit().foregroundStyle(Theme.tertiary)
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 8).fill(rank.account == account ? Theme.accent.opacity(0.08) : Theme.raised))
        .accessibilityElement(children: .combine)
    }

    /// A hero wearing what an entry says: how the others' Tonton is drawn.
    static func wearing(_ equipped: [String: String]) -> RPG.State {
        var hero = RPG.State()
        hero.owned = Array(equipped.values)
        hero.equipped = equipped
        return hero
    }
}
