import Combine
import Foundation
import TontonCore

/// The evening summary of Settings › Notch, from what this Mac recorded today: a macOS notification, once a day, at the
/// time picked. During quiet hours it waits for them to end, the same evening.
@MainActor
final class DailySummaryNotifier {
    private let store: SessionStore
    private let settings: AppSettings
    private var timer: Timer?

    init(store: SessionStore, settings: AppSettings) {
        self.store = store
        self.settings = settings
        // A minute is close enough to the time picked, and costs nothing while the summary is off.
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.check() }
        }
    }

    private func check(at now: Date = Date()) {
        guard settings.dailySummary, !settings.isQuiet(.other),
            DailySummary.isDue(at: now, minutes: settings.dailySummaryTime, lastDay: settings.dailySummaryDay)
        else { return }
        settings.dailySummaryDay = UsageHistory.day(now)
        let usage = store.usage
        let worked = usage.hours.days[UsageHistory.day(now)]?.reduce(0, +) ?? 0
        let sessions = store.sessions.filter { Calendar.current.isDate($0.lastActivity, inSameDayAs: now) }.count
        let cost = settings.showCosts ? usage.history.spent(on: now) : nil
        guard let text = DailySummary.text(worked: worked, sessions: sessions, cost: cost) else { return }
        Notifier.post(title: String(localized: "Today with Claude"), body: text)
    }
}
