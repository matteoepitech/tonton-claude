import ActivityKit
import Foundation
import Observation
import TontonCore

/// The Live Activity: started while the app is open and something runs, updated from the socket, and handed to the
/// relay when the app goes away. A relay with an APNs key keeps it up to date, ends it once nothing has run for a while,
/// and can start the next one (iOS 17.2 and later); without one, it shows as stale after 15 minutes.
@MainActor @Observable
final class IslandController {
    /// Settings › Live Activity.
    var enabled: Bool = UserDefaults.standard.object(forKey: "liveActivity") as? Bool ?? true {
        didSet {
            UserDefaults.standard.set(enabled, forKey: "liveActivity")
            if !enabled { Task { await end() } }
        }
    }
    @ObservationIgnored var onToken: (String?) -> Void = { _ in }
    @ObservationIgnored var onStartToken: (String?) -> Void = { _ in }
    @ObservationIgnored private var watched: Set<String> = []
    /// Going to the background changes the stale date even when the sessions don't change.
    @ObservationIgnored private var wasForeground = true
    /// Without relay pushes, how long the activity stays trustworthy.
    private static let staleAfter: TimeInterval = 15 * 60

    var available: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    /// Follows the activities this app has, including one a relay started by push while the app was not running.
    func observe() {
        for activity in Activity<SessionsActivityAttributes>.activities { watch(activity) }
        Task { [weak self] in
            for await activity in Activity<SessionsActivityAttributes>.activityUpdates { self?.watch(activity) }
        }
        if #available(iOS 17.2, *) {
            Task { [weak self] in
                for await token in Activity<SessionsActivityAttributes>.pushToStartTokenUpdates {
                    self?.onStartToken(PushDevice.hex(token))
                }
            }
        }
    }

    func show(_ state: IslandState, relayPushes: Bool, foreground: Bool) async {
        guard enabled, available else {
            await end()
            return
        }
        let content = ActivityContent(state: state, staleDate: relayPushes ? nil : Date().addingTimeInterval(Self.staleAfter))
        if let activity = current {
            // With the app open and nothing to follow, the Dynamic Island is left free.
            if foreground && !state.isActive {
                await activity.end(content, dismissalPolicy: .immediate)
            } else if activity.content.state != state || foreground != wasForeground {
                await activity.update(content)
            }
        } else if foreground && state.isActive {
            // Only the app in the foreground may start one. With a push token whenever the build can get one: the relay
            // may only say later that it pushes.
            if let activity = (try? request(content, pushType: .token)) ?? (try? request(content, pushType: nil)) { watch(activity) }
        }
        wasForeground = foreground
    }

    private func request(_ content: ActivityContent<IslandState>, pushType: PushType?) throws -> Activity<SessionsActivityAttributes> {
        try Activity.request(attributes: SessionsActivityAttributes(), content: content, pushType: pushType)
    }

    func end() async {
        for activity in Activity<SessionsActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    private var current: Activity<SessionsActivityAttributes>? {
        Activity<SessionsActivityAttributes>.activities.first { $0.activityState == .active || $0.activityState == .stale }
    }

    private func watch(_ activity: Activity<SessionsActivityAttributes>) {
        guard watched.insert(activity.id).inserted else { return }
        Task { [weak self] in
            for await token in activity.pushTokenUpdates { self?.onToken(PushDevice.hex(token)) }
        }
        Task { [weak self] in
            for await state in activity.activityStateUpdates where state == .ended || state == .dismissed {
                // The relay can't push to it anymore, and may start the next one.
                if self?.current == nil { self?.onToken(nil) }
            }
        }
    }
}
