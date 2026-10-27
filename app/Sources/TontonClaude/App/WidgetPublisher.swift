import Combine
import Foundation
import OSLog
import TontonCore
import WidgetKit

/// Keeps the widget's file (WidgetShare) in step with the sessions the notch shows, and reloads the widget when what it
/// draws changes. Bundles built without the widget have no group to share, and skip all of it.
@MainActor
final class WidgetPublisher {
    private let share: WidgetShare
    /// The last snapshot written, which keeps each session's `since` and spares reloads that would change nothing.
    private var last: WidgetSnapshot?
    private var subscriptions = Set<AnyCancellable>()

    init?(store: SessionStore, settings: AppSettings) {
        guard let share = WidgetShare(bundle: .main) else { return nil }
        self.share = share
        last = share.load()
        // A second's pause: a reconnect sends every session at once, and each reload counts against the widget's budget.
        store.sessionsPublisher.map { _ in () }
            .merge(with: settings.$hiddenMachines.map { _ in () }, settings.$hideFinishedAfterHours.map { _ in () })
            .debounce(for: .seconds(1), scheduler: RunLoop.main)
            .sink { [weak self, weak store] in
                guard let self, let store else { return }
                self.publish(WidgetSnapshot(store.visibleSessions, previous: self.last))
            }
            .store(in: &subscriptions)
    }

    /// When the app quits: the widget says so, and no session stays in the file.
    func stop() {
        publish(.stopped)
    }

    private func publish(_ snapshot: WidgetSnapshot) {
        guard snapshot.differs(from: last) else { return }
        do {
            try share.save(snapshot)
        } catch {
            Logger.app.error("widget: \(error.localizedDescription, privacy: .public)")
            return
        }
        last = snapshot
        WidgetCenter.shared.reloadTimelines(ofKind: WidgetSnapshot.kind)
    }
}
