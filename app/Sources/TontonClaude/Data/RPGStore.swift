import Combine
import Foundation
import TontonCore

/// Only committed account state is displayed. Polling also catches rewards earned while this Mac was asleep.
/// Reads and saves are apart: a read never holds back a click, and a click during a save waits for it instead of being
/// dropped.
@MainActor
final class RPGStore: ObservableObject {
    static let shared = RPGStore()
    @Published private(set) var hero = RPG.State()
    @Published private(set) var ready = false
    /// A save is on its way. Reads don't set it.
    @Published private(set) var busy = false
    @Published private(set) var error: String? = String(localized: "Connect an account to grow Tonton.")
    @Published private(set) var gain = 0
    @Published private(set) var leveledUp = false
    @Published var arena: RPGCombat?
    /// The boosters the Boosters page reveals over itself: the ones just opened, or a past opening picked again.
    @Published private(set) var reveal: BoosterReveal?
    /// Committed XP that just arrived, and the level it reached when it crossed one: the notch's float and level-up.
    let earned = PassthroughSubject<(xp: Int, level: Int?), Never>()
    private var account: Account?
    private var polling: Task<Void, Never>?
    private var celebration: Task<Void, Never>?
    private var generation = UUID()
    private var reading = false
    /// Counted at the start and the end of each save: a read that overlapped one may hold the hero it replaced.
    private var saves = 0
    /// Changes asked for during a save, saved one after the other.
    private var queue: [Change] = []
    /// Boosters whose opening went out: revealed once a save's answer, or a later read, shows them opened.
    private var unrevealed: [String] = []

    private struct Change {
        let apply: @Sendable (inout RPG.State) throws -> Void
        var opened: [String] = []
        var won: String?
    }

    func use(_ account: Account?) {
        if account == self.account { return }
        polling?.cancel()
        celebration?.cancel()
        generation = UUID()
        self.account = account
        arena = nil
        reveal = nil
        unrevealed = []
        queue = []
        hero = RPG.State()
        ready = false
        busy = false
        reading = false
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
                if !self.reading {
                    self.reading = true
                    let saves = self.saves
                    do {
                        let (_, next) = try await RPGClient(account: account).read()
                        guard self.generation == generation, !Task.isCancelled else { return }
                        if saves == self.saves { self.accept(next) }
                    } catch {
                        guard self.generation == generation, !Task.isCancelled else { return }
                        let problem =
                            (error as? RelayError)?.status == 404
                            ? String(localized: "Update the relay to enable Tonton's progression.")
                            : String(localized: "Could not sync Tonton. Retrying…")
                        if self.error != problem { self.error = problem }
                    }
                    self.reading = false
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

    func openBooster(_ id: String) { open([id]) }

    /// Every booster in one save, revealed together.
    func openAll() { open(hero.boosters) }

    private func open(_ boosters: [String]) {
        // The drops stay fixed through CAS retries. Only the committed receipts are ever presented.
        guard !boosters.isEmpty, let draws = try? RPG.draws(for: boosters) else { return }
        change({ try $0.openBoosters(draws) }, opened: boosters)
    }

    /// A past opening, shown again as it was, without the suspense.
    func showOpening(_ id: String) { reveal = BoosterReveal(boosters: [id], uncovered: true) }

    func uncoverReveal() { reveal?.uncovered = true }

    func dismissReveal() { reveal = nil }

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

    private func change(_ apply: @escaping @Sendable (inout RPG.State) throws -> Void, opened: [String] = [], won: String? = nil) {
        guard account != nil, ready else { return }
        queue.append(Change(apply: apply, opened: opened, won: won))
        if !busy { saveNext() }
    }

    private func saveNext() {
        guard let account, !queue.isEmpty else { return }
        let next = queue.removeFirst()
        if !next.opened.isEmpty { unrevealed = next.opened }
        busy = true
        saves += 1
        let generation = self.generation
        Task {
            do {
                let state = try await RPGClient(account: account).change(next.apply)
                guard self.generation == generation else { return }
                accept(state)
                if let won = next.won, arena?.id == won { arena?.claimed = true; saveArena() }
            } catch {
                guard self.generation == generation else { return }
                // The save may have reached the relay all the same: the next read reveals the boosters if it did.
                self.error = String(localized: "Could not save this reward or purchase. Reconnect and try again.")
            }
            saves += 1
            busy = false
            saveNext()
        }
    }

    private func accept(_ next: RPG.State) {
        if ready, next.xp > hero.xp {
            earned.send((next.xp - hero.xp, next.level > hero.level ? next.level : nil))
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
        if next != hero { hero = next }
        if !unrevealed.isEmpty, unrevealed.allSatisfy({ next.openings[$0] != nil }) {
            reveal = BoosterReveal(boosters: unrevealed, uncovered: false)
            unrevealed = []
        } else if !busy, unrevealed.contains(where: next.boosters.contains) {
            // The save did not reach the relay: nothing to reveal.
            unrevealed = []
        }
        if !ready { ready = true }
        if error != nil { error = nil }
    }
}
