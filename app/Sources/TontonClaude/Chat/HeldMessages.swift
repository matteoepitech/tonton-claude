import AppKit
import Combine
import Foundation
import SwiftUI
import TontonCore
import UniformTypeIdentifiers

/// Messages from the notch held for the Undo send delay (see UndoSendQueue), for every session, while the app runs. They go
/// through `SessionStore.sendPrompt` like any other, so Claude Code and OpenCode sessions alike can take them back.
@MainActor
final class HeldMessages: ObservableObject {
    static let shared = HeldMessages()

    @Published private(set) var queue = UndoSendQueue()
    /// A held message went: the conversation shows its "sending…" bubble until the transcript has it.
    let sent = PassthroughSubject<HeldMessage, Never>()
    /// A message taken back, for its session's composer to fill in again.
    let undone = PassthroughSubject<HeldMessage, Never>()
    private weak var store: SessionStore?
    private var timer: Timer?

    func attach(_ store: SessionStore) {
        self.store = store
    }

    /// Holds the message for `delay`. False when there is none: it went right away.
    func send(_ text: String, images: [OutgoingImage], to sessionId: String, delay: UndoSendDelay) -> Bool {
        guard queue.hold(text, images: images, to: sessionId, delay: delay) != nil else {
            store?.sendPrompt(text, images: images, to: sessionId)
            return false
        }
        schedule()
        return true
    }

    func undo(_ id: UUID) {
        guard let message = queue.undo(id) else { return }
        undone.send(message)
        schedule()
    }

    /// Sends everything held at once: the notch closed or the app quits, and nothing may be lost. False when nothing was held.
    @discardableResult func flush() -> Bool {
        let messages = queue.flush()
        schedule()
        go(messages)
        return !messages.isEmpty
    }

    func items(for sessionId: String) -> [HeldMessage] { queue.held(for: sessionId) }

    private func schedule() {
        timer?.invalidate()
        timer = nil
        guard let deadline = queue.nextDeadline else { return }
        let timer = Timer(fire: deadline, interval: 0, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.go(self.queue.due())
                self.schedule()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func go(_ messages: [HeldMessage]) {
        for message in messages {
            store?.sendPrompt(message.text, images: message.images, to: message.sessionId)
            sent.send(message)
        }
    }
}

extension Attachment {
    /// A message taken back: its files return to the composer as they were.
    init?(_ image: OutgoingImage) {
        guard let data = Data(base64Encoded: image.data) else { return nil }
        let isImage = image.mediaType.hasPrefix("image/")
        let thumbnail =
            (isImage ? NSImage(data: data) : nil)
            ?? NSWorkspace.shared.icon(for: .init(mimeType: image.mediaType) ?? .data)
        self.init(name: image.name, mediaType: image.mediaType, data: data, thumbnail: thumbnail, isImage: isImage)
    }
}

/// What the "sending…" bubble says for a message: its text, or how many files it carries.
func pendingLabel(_ text: String, images: Int) -> String {
    text.isEmpty ? "(\(images) attachment\(images == 1 ? "" : "s"))" : text
}

/// A message held for Undo send: the "sending…" bubble, with the seconds left and the button that takes it back.
struct HeldBubble: View {
    let message: HeldMessage
    let undo: () -> Void

    var body: some View {
        HStack {
            Spacer(minLength: 60)
            VStack(alignment: .trailing, spacing: 4) {
                Text(pendingLabel(message.text, images: message.images.count))
                    .font(.notch(12))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .foregroundStyle(Theme.onAccent)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Theme.accent.opacity(0.35)))
                HStack(spacing: 6) {
                    TimelineView(.periodic(from: .now, by: 0.25)) { context in
                        Text("sending in \(message.secondsLeft(at: context.date)) s").monospacedDigit()
                    }
                    .font(.notch(9))
                    .foregroundStyle(Theme.tertiary)
                    Button("Undo", action: undo)
                        .buttonStyle(.plain)
                        .font(.notch(10, weight: .semibold))
                        .foregroundStyle(Theme.accent)
                        .help("Take the message back to the message field")
                        .accessibilityLabel("Undo send")
                }
            }
        }
    }
}
