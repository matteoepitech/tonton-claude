import Foundation
import TontonCore

/// Snooze alerts: a session's sounds, notifications, banners and webhooks are muted for a while, its permission requests
/// still come through. `notify` in SessionStore asks `snoozes` before it raises an alert.
extension SessionStore {
    func snooze(_ sessionId: String, for length: AlertSnoozes.Length) {
        snoozes.snooze(sessionId, for: length)
        guard let end = snoozes.end(of: sessionId) else { return }
        // The row's bell goes away on time, without waiting for another change.
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(end.timeIntervalSinceNow, 0) + 1))
            guard let self else { return }
            self.snoozes.prune(keeping: Set(self.sessions.map(\.id)))
        }
    }

    func unsnooze(_ sessionId: String) {
        snoozes.wake(sessionId)
    }

    func isSnoozed(_ sessionId: String) -> Bool {
        snoozes.isSnoozed(sessionId)
    }
}
