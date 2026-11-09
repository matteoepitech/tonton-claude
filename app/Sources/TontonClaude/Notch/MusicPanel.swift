import SwiftUI
import TontonCore

/// What the open notch shows in Music mode, in place of the session list and the conversation.
struct MusicPanel: View {
    @ObservedObject private var music = MusicStore.shared

    var body: some View {
        MusicPlayerView(name: music.playerName, state: music.player, cover: music.cover, perform: music.perform)
            .onAppear { music.viewAppeared() }
            .onDisappear { music.viewDisappeared() }
    }
}
