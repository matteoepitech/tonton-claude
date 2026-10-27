import SwiftUI
import TontonCore

/// Snooze alerts, in a session's context menu: no sound, notification, banner or webhook for a while. Permission requests
/// still come through.
struct SnoozeMenu: View {
    let sessionId: String
    @EnvironmentObject var store: SessionStore

    var body: some View {
        if store.isSnoozed(sessionId) {
            Button("Unsnooze alerts") { store.unsnooze(sessionId) }
        } else {
            Menu("Snooze alerts") {
                ForEach(AlertSnoozes.Length.allCases, id: \.self) { length in
                    Button(length.label) { store.snooze(sessionId, for: length) }
                }
            }
        }
    }
}
