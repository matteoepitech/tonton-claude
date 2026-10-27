import ActivityKit
import TontonCore

/// The Live Activity that shows the account's sessions. A relay that starts one by push names this type
/// (`ACTIVITY_ATTRIBUTES_TYPE` in relay/src/push.ts) and sends `{}` as its attributes: keep both in step.
struct SessionsActivityAttributes: ActivityAttributes {
    typealias ContentState = IslandState
}
