import SwiftUI
import TontonCore

/// What the open notch shows in Music mode, in place of the session list and the conversation.
struct MusicPanel: View {
    @ObservedObject private var music = MusicStore.shared

    var body: some View {
        CenteredMessage(icon: "music.note", title: "Nothing playing", detail: "The music playing on this Mac shows up here.")
            .onAppear { music.viewAppeared() }
            .onDisappear { music.viewDisappeared() }
    }
}
