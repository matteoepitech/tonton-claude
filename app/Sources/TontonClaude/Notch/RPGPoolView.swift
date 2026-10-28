import SwiftUI
import TontonCore

/// A compact route to pool standings and cooperative rewards. Every refresh uses the current pool keyring.
struct RPGPoolView: View {
    @ObservedObject private var pools = PoolStore.shared
    @ObservedObject private var rpg = RPGStore.shared
    @State private var selected = ""
    @State private var ledger: RPGPoolLedger?
    @State private var problem = false
    @State private var period = "run"
    @State private var confirmRun = false
    private var board: PoolBoard? { pools.boards[selected] ?? pools.ordered.first }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Team progression").font(.title2.bold())
                if pools.ordered.isEmpty {
                    Text("Join a pool to share Tonton's level and equipped look with your team.")
                } else {
                    Picker("Pool", selection: $selected) {
                        ForEach(pools.ordered, id: \.id) { Text($0.name).tag($0.id) }
                    }
                }
                if let board, let state = board.state {
                    Picker("Period", selection: $period) {
                        Text("Today (UTC)").tag("today")
                        Text("This run").tag("run")
                        Text("All time").tag("all")
                    }.pickerStyle(.segmented)
                    if let ledger {
                        let start =
                            period == "all"
                            ? ""
                            : period == "run"
                                ? RPGPoolLedger.runStart(state)
                                : String(ISO8601DateFormatter().string(from: Date()).prefix(10)) + "T00:00:00Z"
                        ForEach(Array(ledger.standings(state, since: start).enumerated()), id: \.element.id) { index, row in
                            HStack {
                                Text("#\(index + 1)").monospacedDigit()
                                MascotView(status: .idle, size: 36, hero: row.profile.hero)
                                VStack(alignment: .leading) {
                                    Text(row.profile.name)
                                    Text("Level \(row.profile.level)").font(.caption)
                                    if row.departed { Text("Left the pool").font(.caption).foregroundStyle(.secondary) }
                                }
                                Spacer()
                                Text("\(row.xp) contribution XP").font(.caption)
                            }
                        }
                        Text("Team goals").font(.headline)
                        let count = ledger.completedCount(since: RPGPoolLedger.runStart(state))
                        ForEach(RPGPoolLedger.targets, id: \.self) { target in
                            VStack(alignment: .leading) {
                                Text("\(min(count, target))/\(target) completed tasks · one booster")
                                ProgressView(value: Double(min(count, target)), total: Double(target))
                            }
                        }
                        Text("Contribute before a goal is reached to earn its booster. Rewards stay claimable after reconnecting.")
                            .font(.caption).foregroundStyle(.secondary)
                        Button("Claim team boosters") { rpg.claimTeam(ledger) }
                            .disabled(rpg.busy || !rpg.ready || !rpg.teamEligible(ledger))
                    } else {
                        ProgressView()
                    }
                    if problem {
                        Text("Could not sync team progression. Check the connection and relay version.").foregroundStyle(Theme.warning)
                    }
                    if let url = pools.websiteURL(of: board.id) { Link("Open pool leaderboard", destination: url) }
                    if board.summary.role == .owner || board.summary.role == .admin {
                        Button("Start a new competition run") { confirmRun = true }
                            .confirmationDialog(
                                "Start a new run? Permanent heroes and previous rewards are kept.", isPresented: $confirmRun
                            ) {
                                Button("Start new run") { pools.beginRPGRun(board) }
                            }
                    }
                }
            }.padding(18)
        }
        .background(Theme.bg).foregroundStyle(Theme.text)
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
}
