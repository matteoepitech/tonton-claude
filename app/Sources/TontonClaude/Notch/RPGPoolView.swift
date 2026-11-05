import AppKit
import SwiftUI
import TontonCore

// The hero screen's Team page (#358): a pool's standings by contribution XP, its team goals and their boosters, in the
// notch's look. Every refresh uses the current pool keyring.

/// A compact route to pool standings and cooperative rewards.
struct RPGPoolView: View {
    @ObservedObject private var pools = PoolStore.shared
    @ObservedObject private var rpg = RPGStore.shared
    @State private var selected = ""
    @State private var ledger: RPGPoolLedger?
    @State private var problem = false
    @State private var period = RPGPoolLedger.Period.run
    @State private var confirmRun = false
    private var board: PoolBoard? { pools.boards[selected] ?? pools.ordered.first }

    var body: some View {
        ScrollView {
            content.padding(.vertical, 4)
        }
        .scrollIndicators(.never)
        .foregroundStyle(Theme.text)
        .task(id: board?.id) {
            ledger = nil
            while !Task.isCancelled {
                guard let current = board else { return }
                do {
                    let next = try await pools.rpgLedger(current, hero: rpg.hero)
                    guard !Task.isCancelled else { return }
                    ledger = next; problem = false
                } catch { problem = true }
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    private var content: TeamPageContent {
        let state = board?.state
        let team = ledger.flatMap { ledger in
            state.map { state in
                TeamPageContent.Team(
                    rows: ledger.standings(state, since: RPGPoolLedger.start(of: period, in: state)),
                    completed: ledger.completedCount(since: RPGPoolLedger.runStart(state)), claimable: rpg.teamEligible(ledger))
            }
        }
        let role = board?.summary.role
        return TeamPageContent(
            pools: pools.ordered.map { ($0.id, $0.name) }, pool: board?.id, poolReady: state != nil, team: team,
            account: pools.accountId, period: $period, problem: problem, enabled: rpg.ready && !rpg.busy,
            canStartRun: role == .owner || role == .admin, hasLeaderboard: board.flatMap { pools.websiteURL(of: $0.id) } != nil,
            confirmRun: $confirmRun,
            pick: { selected = $0 },
            claim: { if let ledger { rpg.claimTeam(ledger) } },
            leaderboard: { if let url = board.flatMap({ pools.websiteURL(of: $0.id) }) { NSWorkspace.shared.open(url) } },
            startRun: { if let board { pools.beginRPGRun(board) } })
    }
}

/// Pure presentation, also used by the image renderer: no account, store or network.
struct TeamPageContent: View {
    struct Team {
        let rows: [RPGPoolLedger.Standing]
        /// Tasks completed in this run, for the goals.
        let completed: Int
        let claimable: Bool
    }

    let pools: [(id: String, name: String)]
    let pool: String?
    let poolReady: Bool
    /// Nil while the ledger loads.
    let team: Team?
    let account: String?
    @Binding var period: RPGPoolLedger.Period
    var problem = false
    var enabled = true
    var canStartRun = false
    var hasLeaderboard = false
    @Binding var confirmRun: Bool
    var pick: (String) -> Void = { _ in }
    var claim: () -> Void = {}
    var leaderboard: () -> Void = {}
    var startRun: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if pools.isEmpty {
                HStack(spacing: 10) {
                    IconTile(systemName: "person.3.fill", tint: Theme.accent, size: 28).accessibilityHidden(true)
                    Text("Join a pool to share Tonton's level and equipped look with your team.")
                        .font(.notch(11)).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .poolCard(padding: 9)
            } else if poolReady {
                HStack(spacing: 5) {
                    ForEach(RPGPoolLedger.Period.allCases, id: \.self) { item in
                        PoolChoice(title: Self.label(item), picked: period == item) { period = item }
                    }
                }
                if let team {
                    standings(team.rows)
                    goals(team)
                } else {
                    Text("Reading the team's progress…").font(.notch(11)).foregroundStyle(Theme.tertiary).padding(.vertical, 6)
                }
                if problem {
                    Text("Could not sync team progression. Check the connection and relay version.")
                        .font(.notch(11)).foregroundStyle(Theme.warning).fixedSize(horizontal: false, vertical: true)
                }
                footer
            }
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            VStack(alignment: .leading, spacing: 1) {
                Text("Team progression").font(.notch(10, weight: .semibold)).foregroundStyle(Theme.tertiary)
                if pools.count == 1, let name = pools.first?.name {
                    Text(verbatim: name).font(.notch(13, weight: .bold)).lineLimit(1)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 6)
            if pools.count > 1 {
                NotchMenu(width: 220) {
                    [
                        NotchMenuSection(
                            title: String(localized: "Pool"),
                            items: pools.map { item in NotchMenuItem(title: item.name, checked: item.id == pool) { pick(item.id) } })
                    ]
                } label: {
                    NotchMenuLabel(text: pools.first { $0.id == pool }?.name ?? "", size: 11)
                }
                .foregroundStyle(Theme.text)
                .accessibilityLabel("Pool")
            }
        }
    }

    private func standings(_ rows: [RPGPoolLedger.Standing]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                HStack(spacing: 8) {
                    Text(verbatim: "\(index + 1)")
                        .font(.system(size: Theme.textSize.points(13), weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(Theme.tertiary)
                        .frame(minWidth: 18)
                    HeroSprite(hero: row.profile.hero, pose: .idle, size: 32, animated: false)
                        .opacity(row.departed ? 0.4 : 1)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 5) {
                            Text(verbatim: row.profile.name).font(.notch(11.5, weight: .bold)).lineLimit(1)
                            if row.id == account { PoolChip(text: String(localized: "You")) }
                            if row.departed { PoolChip(text: String(localized: "Left the pool"), tint: Theme.textDim) }
                        }
                        Text("Level \(row.profile.level) · \(RPG.title(level: row.profile.level))")
                            .font(.notch(10)).foregroundStyle(Theme.secondary)
                    }
                    Spacer(minLength: 6)
                    VStack(alignment: .trailing, spacing: 1) {
                        Text(verbatim: "\(row.xp)").font(.notch(11.5, weight: .bold)).monospacedDigit()
                        Text("contribution XP").font(.notch(9.5)).foregroundStyle(Theme.tertiary)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: 8).fill(row.id == account ? Theme.accent.opacity(0.08) : Theme.raised))
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func goals(_ team: Team) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text("Team goals").font(.notch(13, weight: .bold)).accessibilityAddTraits(.isHeader)
                Spacer(minLength: 6)
                Button("Claim team boosters", action: claim)
                    .buttonStyle(NotchButtonStyle(kind: team.claimable ? .primary : .secondary))
                    .disabled(!enabled || !team.claimable)
            }
            ForEach(RPGPoolLedger.targets, id: \.self) { target in
                let reached = team.completed >= target
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Image(systemName: reached ? "checkmark.seal.fill" : "flag.fill")
                            .font(.notch(11, weight: .semibold))
                            .foregroundStyle(reached ? Theme.success : Theme.accent)
                            .frame(width: 14)
                            .accessibilityHidden(true)
                        Text("\(min(team.completed, target))/\(target) completed tasks · one booster")
                            .font(.notch(11, weight: .semibold)).monospacedDigit()
                        Spacer(minLength: 0)
                    }
                    PoolProgress(done: min(team.completed, target), total: target)
                }
                .poolCard(padding: 9)
            }
            Text("Contribute before a goal is reached to earn its booster. Rewards stay claimable after reconnecting.")
                .font(.notch(10)).foregroundStyle(Theme.tertiary).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 4)
    }

    @ViewBuilder private var footer: some View {
        if hasLeaderboard || (canStartRun && !confirmRun) {
            HStack(spacing: 6) {
                if hasLeaderboard {
                    Button(action: leaderboard) { Label("Open pool leaderboard", systemImage: "safari") }
                        .buttonStyle(NotchButtonStyle())
                }
                Spacer(minLength: 6)
                if canStartRun && !confirmRun {
                    Button("Start a new competition run") { confirmRun = true }.buttonStyle(NotchButtonStyle())
                }
            }
            .padding(.top, 4)
        }
        if canStartRun && confirmRun {
            VStack(alignment: .leading, spacing: 8) {
                Text("Start a new run? Permanent heroes and previous rewards are kept.")
                    .font(.notch(11)).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    Spacer()
                    Button("Cancel") { confirmRun = false }.buttonStyle(NotchButtonStyle())
                    Button("Start new run") {
                        confirmRun = false
                        startRun()
                    }
                    .buttonStyle(NotchButtonStyle(kind: .destructive))
                }
            }
            .poolCard(highlighted: true, padding: 9)
        }
    }

    static func label(_ period: RPGPoolLedger.Period) -> String {
        switch period {
        case .today: String(localized: "Today (UTC)")
        case .run: String(localized: "This run")
        case .all: String(localized: "All time")
        }
    }
}
