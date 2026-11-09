import SwiftUI
import TontonCore

/// What the open notch shows in Music mode, in place of the session list and the conversation: the player `MusicStore`
/// chose, or a button for each player on this Mac while none runs.
struct MusicPanel: View {
    @ObservedObject private var music = MusicStore.shared

    var body: some View {
        Group {
            if let shown = music.shown {
                MusicPlayerView(
                    name: shown.name, state: shown.state, cover: music.cover, perform: music.perform,
                    showsName: MusicChoice.namesPlayer(music.allPlayers))
            } else {
                NoMusicPlayerView(players: MusicChoice.openable(music.allPlayers), perform: music.perform)
            }
        }
        .onAppear { music.viewAppeared() }
        .onDisappear { music.viewDisappeared() }
    }
}
