import Combine
import Foundation
import TontonCore

/// Only committed account state is displayed. Polling also catches rewards earned while this Mac was asleep.
@MainActor
final class RPGStore: ObservableObject {
    static let shared = RPGStore()
    @Published private(set) var hero = RPG.State()
    @Published private(set) var ready = false
    @Published private(set) var busy = false
    @Published private(set) var error: String? = String(localized: "Connect an account to grow Tonton.")
    @Published private(set) var gain = 0
    @Published private(set) var leveledUp = false
    @Published var arena: RPGCombat?
    @Published private(set) var opening: String?
    private var account: Account?
    private var polling: Task<Void, Never>?
    private var celebration: Task<Void, Never>?
    private var generation = UUID()

    func use(_ account: Account?) {
        if account == self.account { return }
        polling?.cancel()
        celebration?.cancel()
        generation = UUID()
        self.account = account
        arena = nil
        opening = nil
        hero = RPG.State()
        ready = false
        busy = false
        gain = 0
        leveledUp = false
        error = account == nil ? String(localized: "Connect an account to grow Tonton.") : nil
        guard let account else { return }
        if let blob = UserDefaults.standard.string(forKey: runKey(account)),
            var saved = try? E2E.open(blob, as: RPGCombat.self, with: account.symmetricKey())
        {
            saved.pause()
            arena = saved
        }
        let generation = self.generation
        polling = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.generation == generation else { return }
                if !self.busy {
                    self.busy = true
                    do {
                        let (_, next) = try await RPGClient(account: account).read()
                        guard self.generation == generation, !Task.isCancelled else { return }
                        self.accept(next)
                    } catch {
                        guard self.generation == generation, !Task.isCancelled else { return }
                        self.error =
                            (error as? RelayError)?.status == 404
                            ? String(localized: "Update the relay to enable Tonton's progression.")
                            : String(localized: "Could not sync Tonton. Retrying…")
                    }
                    self.busy = false
                }
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    func equip(_ item: RPG.Item?, slot: RPG.Slot) {
        change { try $0.equip(item?.id, in: slot) }
    }

    func upgrade(_ stat: String) {
        let rank = (hero.upgrades[stat] ?? 0) + 1
        change { try $0.upgrade(stat, rank: rank) }
    }

    func openBooster(_ id: String) {
        guard let item = try? RPG.randomItem() else { return }
        // The candidate stays fixed through CAS retries. Only the committed receipt is ever presented.
        change({ try $0.openBooster(id, item: item.id) }, opened: id)
    }

    func showOpening(_ id: String) { opening = id }

    func startArena() {
        guard ready else { return }
        if arena == nil || (arena?.phase == .lost) || (arena?.claimed == true) {
            arena = RPGCombat(hero: hero, seed: UInt64.random(in: 1 ... .max))
        }
        saveArena()
        RPGArenaWindow.shared.show()
    }

    func saveArena() {
        guard let account, let arena, let blob = try? E2E.seal(arena, with: account.symmetricKey()) else { return }
        UserDefaults.standard.set(blob, forKey: runKey(account))
    }

    private func runKey(_ account: Account) -> String { "rpg-run:\(account.relay):\(account.accountId)" }

    func claimVictory() {
        guard let arena, arena.phase == .won, !arena.claimed else { return }
        saveArena()
        let rewards = arena.rewards()
        change(
            { hero in
                for reward in rewards { try hero.award(reward) }
                try hero.claimMilestones()
            }, won: arena.id)
    }

    func teamEligible(_ ledger: RPGPoolLedger) -> Bool {
        guard let account else { return false }
        return ledger.goals.contains { id, goal in
            goal.eligible.contains(account.accountId) && !hero.boosters.contains(id) && hero.openings[id] == nil
        }
    }
    func claimTeam(_ ledger: RPGPoolLedger) {
        guard let account else { return }
        change { try ledger.claim(&$0, account: account.accountId) }
    }

    func claimAchievements() { change { try $0.claimMilestones() } }

    private func change(_ apply: @escaping @Sendable (inout RPG.State) throws -> Void, opened: String? = nil, won: String? = nil) {
        guard let account, ready, !busy else { return }
        busy = true
        let generation = self.generation
        Task {
            do {
                let next = try await RPGClient(account: account).change(apply)
                guard self.generation == generation else { return }
                accept(next)
                if let opened { opening = opened }
                if let won, arena?.id == won { arena?.claimed = true; saveArena() }
            } catch {
                guard self.generation == generation else { return }
                self.error = String(localized: "Could not save this reward or purchase. Reconnect and try again.")
            }
            busy = false
        }
    }

    private func accept(_ next: RPG.State) {
        if ready, next.xp > hero.xp {
            gain += next.xp - hero.xp
            leveledUp = leveledUp || next.level > hero.level
            celebration?.cancel()
            celebration = Task { [weak self] in
                try? await Task.sleep(for: .seconds(4))
                guard !Task.isCancelled else { return }
                self?.gain = 0
                self?.leveledUp = false
            }
        }
        hero = next
        ready = true
        error = nil
    }
}
