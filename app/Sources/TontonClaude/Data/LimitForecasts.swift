import Combine
import Foundation
import SwiftUI
import TontonCore

/// The 5-hour limit readings of every session as they arrive, kept while the app runs, and the forecast they give (see
/// LimitHistory). Claude Code sessions only send a limit: OpenCode has no plan limits.
@MainActor
final class LimitForecasts: ObservableObject {
    static let shared = LimitForecasts()

    @Published private(set) var history = LimitHistory()
    private var subscription: AnyCancellable?

    func attach(_ store: SessionStore) {
        subscription = store.sessionsPublisher.sink { [weak self] sessions in
            guard let self else { return }
            var history = self.history
            for limit in sessions.compactMap(\.fiveHourLimit) { history.record(limit) }
            // Most updates carry the same readings: only a new one redraws the labels.
            if history != self.history { self.history = history }
        }
    }

    func forecast(for limit: UsageLimit, at now: Date = Date()) -> LimitHistory.Forecast? {
        history.forecast(for: limit, at: now)
    }

    /// The gauge's tooltip: how much is used, when it resets, and the forecast when there is one.
    func tooltip(for limit: UsageLimit, at now: Date = Date()) -> String {
        let used =
            "5-hour limit: \(Int(limit.usedPercent.rounded())) % used, resets at \(limit.resetsAt.formatted(date: .omitted, time: .shortened))"
        guard let forecast = forecast(for: limit, at: now) else { return used }
        return "\(used). \(forecast.text()) at this pace."
    }
}

/// `Out ~15:40` next to the session's status, when the 5-hour window runs out before it resets at this pace.
struct LimitForecastLabel: View {
    let limit: UsageLimit?
    @ObservedObject private var forecasts = LimitForecasts.shared

    var body: some View {
        TimelineView(.everyMinute) { context in
            if let limit, case .runsOut(let date)? = forecasts.forecast(for: limit, at: context.date) {
                Label(date.formatted(date: .omitted, time: .shortened), systemImage: "hourglass")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Color(nsColor: .systemOrange))
                    .lineLimit(1)
                    .fixedSize()
                    .help(
                        "At this pace, the 5-hour limit runs out around \(date.formatted(date: .omitted, time: .shortened)), "
                            + "before it resets at \(limit.resetsAt.formatted(date: .omitted, time: .shortened)).")
            }
        }
    }
}
