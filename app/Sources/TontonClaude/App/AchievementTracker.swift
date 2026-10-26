import Combine
import Foundation
import TontonCore

/// Counts what earns achievements, saves the progress in the user defaults and shows each new badge under the notch.
@MainActor
final class AchievementTracker {
    private let notch: NotchState
    private let settings: AppSettings
    private var queue: [Achievement] = []
    private var subscriptions = Set<AnyCancellable>()

    init(store: SessionStore, notch: NotchState, settings: AppSettings) {
        self.notch = notch
        self.settings = settings
        store.sessionsPublisher.sink { [weak self] sessions in self?.update { $0.sessionsChanged(sessions) } }.store(in: &subscriptions)
        store.approved.sink { [weak self] in self?.update { $0.approved() } }.store(in: &subscriptions)
        store.sent.sink { [weak self] in self?.update { $0.sentFromNotch() } }.store(in: &subscriptions)
    }

    private func update(_ change: (inout AchievementProgress) -> [Achievement]) {
        let new = change(&AchievementStore.shared.progress)
        guard !new.isEmpty else { return }
        queue += new
        if notch.achievement == nil { showNext() }
    }

    /// One badge at a time, four seconds each; none during quiet hours, they are still unlocked.
    private func showNext() {
        guard !queue.isEmpty else { return }
        let next = queue.removeFirst()
        guard !settings.isQuietNow else { return showNext() }
        notch.achievement = next
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            self?.notch.achievement = nil
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self?.showNext() }
        }
    }
}

/// The saved progress, shared with the Settings list.
@MainActor
final class AchievementStore: ObservableObject {
    static let shared = AchievementStore()

    @Published var progress: AchievementProgress {
        didSet { if let data = try? JSONEncoder().encode(progress) { UserDefaults.standard.set(data, forKey: "achievements") } }
    }

    init() {
        progress =
            UserDefaults.standard.data(forKey: "achievements").flatMap { try? JSONDecoder().decode(AchievementProgress.self, from: $0) }
            ?? AchievementProgress()
    }
}
