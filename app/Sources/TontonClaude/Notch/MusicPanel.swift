import SwiftUI
import TontonCore

/// What the open notch shows in Music mode, in place of the session list and the conversation.
struct MusicPanel: View {
    @ObservedObject private var music = MusicStore.shared

    var body: some View {
        // With none shown, the first player says it is not open, with a button that opens it.
        let player = music.shown ?? music.allPlayers.first
        MusicPlayerView(
            name: player?.name ?? "", state: player?.state ?? MusicPlayerState(), cover: music.cover, perform: music.perform
        )
        .onAppear { music.viewAppeared() }
        .onDisappear { music.viewDisappeared() }
    }
}
