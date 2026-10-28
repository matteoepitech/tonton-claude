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
        hero = RPG.State()
        ready = false
        busy = false
        gain = 0
        leveledUp = false
        error = account == nil ? String(localized: "Connect an account to grow Tonton.") : nil
        guard let account else { return }
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
        guard let account, ready, !busy else { return }
        busy = true
        let generation = self.generation
        Task {
            do {
                let next = try await RPGClient(account: account).change { try $0.equip(item?.id, in: slot) }
                guard self.generation == generation else { return }
                accept(next)
            } catch {
                guard self.generation == generation else { return }
                self.error = String(localized: "Could not equip this item. Try again.")
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
