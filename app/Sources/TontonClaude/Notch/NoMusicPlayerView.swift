import SwiftUI
import TontonCore

/// The music view while no player runs and none is pinned in Settings: a button opens each player on this Mac. It looks
/// like `CenteredMessage`, with a button per player.
struct NoMusicPlayerView: View {
    /// Those on this Mac that don't run (`MusicChoice.openable`), in the store's order.
    let players: [MusicChoice.Player]
    let perform: (MusicAction) -> Void

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "music.note")
                .font(.notch(26, weight: .medium))
                .foregroundStyle(Theme.ink.opacity(0.85))
                .frame(width: 58, height: 58)
                .background(Circle().fill(Theme.ink.opacity(0.08)))
                .overlay(Circle().stroke(Theme.line(0.12)))
                .accessibilityHidden(true)
            Text("No music player is open").font(.notch(15, weight: .semibold))
            Text("Open one and the music it plays shows up here, with its controls.")
                .font(.notch(12))
                .foregroundStyle(Theme.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)
            if !players.isEmpty {
                HStack(spacing: 8) {
                    ForEach(players, id: \.app) { player in
                        Button {
                            perform(.launch(player.app))
                        } label: {
                            Text("Open \(player.name)").font(.notch(12, weight: .medium)).padding(.horizontal, 14).padding(.vertical, 6)
                        }
                        .buttonStyle(.plain)
                        .background(Capsule().fill(Theme.ink.opacity(0.14)))
                        .overlay(Capsule().stroke(Theme.line(0.18)))
                    }
                }
                .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
