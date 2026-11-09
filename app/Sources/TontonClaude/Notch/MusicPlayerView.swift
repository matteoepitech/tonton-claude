import AppKit
import SwiftUI
import TontonCore

/// What the music view asks for. `MusicStore` hands it to the player, or opens System Settings.
enum MusicAction: Equatable {
    case command(MusicCommand)
    /// A click on the cover: the player comes to the front.
    case showPlayer
    case openPlayer
    case openAutomationSettings
}

/// The music view of the open notch: the cover, the track, where it is, the buttons and the volume, or what keeps them
/// from showing. It only shows what it is given: `MusicPanel` gives it `MusicStore`'s player.
struct MusicPlayerView: View {
    /// The player's name, "Spotify".
    let name: String
    let state: MusicPlayerState
    let cover: NSImage?
    let perform: (MusicAction) -> Void

    var body: some View {
        switch state.screen {
        case .playing(let now):
            NowPlayingCard(name: name, now: now, cover: cover, perform: perform)
        case .notInstalled:
            CenteredMessage(
                icon: "music.note", title: "\(name) is not installed", detail: "The music it plays shows up here once it is on this Mac.")
        case .notRunning:
            CenteredMessage(
                icon: "music.note", title: "\(name) is not open",
                detail: "Open it and the music it plays shows up here, with its controls.", action: "Open \(name)"
            ) { perform(.openPlayer) }
        case .denied:
            CenteredMessage(
                icon: "lock", title: "Tonton Claude can't control \(name)",
                detail: "Turn on \(name) under Tonton Claude in System Settings › Privacy & Security › Automation.",
                action: "Open System Settings"
            ) { perform(.openAutomationSettings) }
        case .waiting:
            CenteredMessage(
                icon: "music.note", title: "Connecting to \(name)…", detail: "If macOS asks, allow Tonton Claude to control \(name).")
        case .nothing:
            CenteredMessage(
                icon: "music.note", title: "Nothing playing", detail: "Play something in \(name) and it shows up here.",
                action: "Show \(name)"
            ) { perform(.showPlayer) }
        }
    }
}

/// A track that plays or is paused.
private struct NowPlayingCard: View {
    let name: String
    let now: NowPlaying
    let cover: NSImage?
    let perform: (MusicAction) -> Void
    /// Where the pointer drags the position or the volume to, from 0 to 1: the bars follow it rather than the player.
    @State private var seeking: Double?
    @State private var volume: Double?

    private static let coverSize: CGFloat = 168

    var body: some View {
        HStack(alignment: .center, spacing: 24) {
            coverButton
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(now.title.isEmpty ? name : now.title)
                        .font(.notch(17, weight: .semibold))
                        .lineLimit(2)
                    if !now.artist.isEmpty {
                        Text(now.artist).font(.notch(13)).foregroundStyle(Theme.secondary).lineLimit(1)
                    }
                    if !now.album.isEmpty {
                        Text(now.album).font(.notch(12)).foregroundStyle(Theme.tertiary).lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                position
                controls
                if let level = now.volume { volumeRow(level) }
            }
            .frame(maxWidth: 360)
        }
        .padding(.horizontal, 28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var coverButton: some View {
        Button {
            perform(.showPlayer)
        } label: {
            ZStack {
                RoundedRectangle(cornerRadius: 10).fill(Theme.ink.opacity(0.08))
                if let cover {
                    Image(nsImage: cover).resizable().interpolation(.high).aspectRatio(contentMode: .fill)
                } else {
                    Image(systemName: "music.note").font(.notch(44, weight: .medium)).foregroundStyle(Theme.tertiary)
                }
            }
            .frame(width: Self.coverSize, height: Self.coverSize)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line(0.1)))
            // The note in place of a cover stays flat: a shadow would ring it.
            .shadow(color: .black.opacity(cover == nil ? 0 : 0.25), radius: 10, y: 4)
        }
        .buttonStyle(.plain)
        .help("Show \(name)")
        .accessibilityLabel("Show \(name)")
    }

    /// Ticks every second while the track plays, and only while the view is on screen: the timeline stops with it.
    private var position: some View {
        TimelineView(.animation(minimumInterval: 1, paused: !now.isPlaying || seeking != nil)) { context in
            let duration = now.duration ?? 0
            let elapsed = seeking.map { $0 * duration } ?? now.elapsed(at: context.date) ?? 0
            VStack(spacing: 5) {
                MusicBar(
                    value: duration > 0 ? elapsed / duration : 0, enabled: duration > 0, label: "Position",
                    valueText: TrackTime.text(elapsed),
                    changed: { seeking = $0 },
                    ended: { fraction in
                        perform(.command(.seek(fraction * duration)))
                        seeking = nil
                    })
                HStack {
                    Text(TrackTime.text(elapsed))
                    Spacer()
                    if duration > 0 { Text(TrackTime.text(duration)) }
                }
                .font(.notch(10, design: .monospaced))
                .foregroundStyle(Theme.tertiary)
                .accessibilityHidden(true)
            }
        }
    }

    private var controls: some View {
        HStack(spacing: 26) {
            control("backward.fill", size: 15, label: "Previous track") { perform(.command(.previousTrack)) }
            Button {
                perform(.command(.playPause))
            } label: {
                Image(systemName: now.isPlaying ? "pause.fill" : "play.fill")
                    .font(.notch(18, weight: .semibold))
                    .foregroundStyle(Theme.bg)
                    .frame(width: 42, height: 42)
                    .background(Circle().fill(Theme.ink.opacity(0.9)))
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .help(now.isPlaying ? "Pause" : "Play")
            .accessibilityLabel(now.isPlaying ? "Pause" : "Play")
            control("forward.fill", size: 15, label: "Next track") { perform(.command(.nextTrack)) }
        }
        .frame(maxWidth: .infinity)
    }

    private func control(_ icon: String, size: CGFloat, label: LocalizedStringKey, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.notch(size, weight: .medium))
                .foregroundStyle(Theme.ink.opacity(0.8))
                .frame(width: 30, height: 30)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(label)
        .accessibilityLabel(label)
    }

    private func volumeRow(_ level: Int) -> some View {
        let shown = volume ?? Double(level) / 100
        return HStack(spacing: 8) {
            Image(systemName: shown == 0 ? "speaker.slash.fill" : shown < 0.5 ? "speaker.wave.1.fill" : "speaker.wave.2.fill")
                .font(.notch(10))
                .foregroundStyle(Theme.tertiary)
                .frame(width: 16)
                .accessibilityHidden(true)
            MusicBar(
                value: shown, label: "Volume", valueText: shown.formatted(.percent.precision(.fractionLength(0))),
                changed: { fraction in
                    volume = fraction
                    perform(.command(.volume(Int((fraction * 100).rounded()))))
                },
                ended: { fraction in
                    perform(.command(.volume(Int((fraction * 100).rounded()))))
                    volume = nil
                })
        }
        // Shorter than the position, under the buttons.
        .frame(maxWidth: 200)
        .frame(maxWidth: .infinity)
    }
}

/// A thin bar to drag, for the position and the volume. It thickens under the pointer, and the arrow keys of VoiceOver
/// move it by a tenth.
private struct MusicBar: View {
    let value: Double
    var enabled = true
    let label: LocalizedStringKey
    let valueText: String
    let changed: (Double) -> Void
    let ended: (Double) -> Void
    @State private var hovering = false
    @State private var dragging = false

    var body: some View {
        GeometryReader { proxy in
            let width = max(proxy.size.width, 1)
            let fraction = min(max(value, 0), 1)
            let active = enabled && (hovering || dragging)
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.ink.opacity(0.14))
                Capsule().fill(Theme.ink.opacity(active ? 0.95 : 0.75)).frame(width: fraction * width)
                if active {
                    Circle().fill(Theme.ink).frame(width: 10, height: 10).offset(x: fraction * width - 5)
                }
            }
            .frame(height: active ? 5 : 3)
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { drag in
                        guard enabled else { return }
                        dragging = true
                        changed(min(max(drag.location.x / width, 0), 1))
                    }
                    .onEnded { drag in
                        guard enabled else { return }
                        dragging = false
                        ended(min(max(drag.location.x / width, 0), 1))
                    }
            )
        }
        .frame(height: 14)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering || dragging)
        .accessibilityElement()
        .accessibilityLabel(label)
        .accessibilityValue(valueText)
        .accessibilityAdjustableAction { direction in
            guard enabled else { return }
            let step = direction == .increment ? 0.1 : direction == .decrement ? -0.1 : 0
            ended(min(max(value + step, 0), 1))
        }
    }
}
