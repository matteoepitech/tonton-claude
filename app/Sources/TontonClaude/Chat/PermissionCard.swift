import AppKit
import SwiftUI
import TontonCore

/// A permission request: Allow and Deny buttons, ⌘↩ to allow, or a two-finger swipe on the trackpad, right to allow and
/// left to deny. The swipe arrives as scroll events, read in the notch panel while they start over the card.
struct PermissionCard: View {
    let request: PermissionRequest
    let answer: (Bool) -> Void
    @EnvironmentObject var settings: AppSettings
    @State private var swipe = SwipeToAnswer()
    @State private var tracking = false
    /// Set once answered by a swipe, while the card leaves.
    @State private var flyOff: CGFloat?
    @State private var frame: CGRect = .zero
    @State private var monitor: Any?

    var body: some View {
        ZStack {
            hint
            card.offset(x: flyOff ?? swipe.offset)
        }
        // The card slides within its own frame, never over the session list.
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .background(
            GeometryReader { geo in
                Color.clear
                    .onAppear { frame = geo.frame(in: .global) }
                    .onChange(of: geo.frame(in: .global)) { _, value in frame = value }
            }
        )
        .onAppear { monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { handle($0) } }
        .onDisappear {
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "lock.shield").foregroundStyle(Theme.accent)
                Text("Allow \(request.toolName)?").font(.system(size: 12, weight: .bold))
                Spacer()
            }
            Text(request.description).font(.system(size: 11)).foregroundStyle(.secondary)
            if !request.inputPreview.isEmpty {
                Text(request.inputPreview)
                    .font(.system(size: 10, design: .monospaced))
                    .textSelection(.enabled)
                    .lineLimit(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(6)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Theme.ink.opacity(0.06)))
            }
            HStack {
                Spacer()
                Button("Deny") { answer(false) }
                Button("Allow") { answer(true) }
                    .keyboardShortcut(.return, modifiers: .command)
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accent)
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.surface))
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.accent.opacity(0.12)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.accent.opacity(0.4)))
        .help("Swipe right with two fingers to allow, left to deny")
    }

    /// Uncovered as the card moves: what letting go does.
    private var hint: some View {
        let allow = swipe.offset >= 0
        let color = allow ? Theme.success : Theme.danger
        return RoundedRectangle(cornerRadius: 10)
            .fill(color.opacity(0.08 + 0.22 * swipe.progress))
            .overlay(alignment: allow ? .leading : .trailing) {
                Label(allow ? "Allow" : "Deny", systemImage: allow ? "checkmark" : "xmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(color)
                    .padding(.horizontal, 14)
            }
            .opacity(flyOff == nil && swipe.offset != 0 ? 1 : 0)
    }

    private func handle(_ event: NSEvent) -> NSEvent? {
        guard flyOff == nil, event.window is NotchPanel, event.hasPreciseScrollingDeltas else { return event }
        switch event.phase {
        case .began:
            // The card does not scroll, so any gesture that starts on it is a swipe; only its horizontal part counts.
            guard contains(event) else { return event }
            tracking = true
        case .changed:
            guard tracking else { return event }
            move(by: event.isDirectionInvertedFromDevice ? event.scrollingDeltaX : -event.scrollingDeltaX)
        case .ended, .cancelled:
            guard tracking else { return event }
            tracking = false
            finish()
        default:
            return event
        }
        return nil
    }

    private func contains(_ event: NSEvent) -> Bool {
        guard let height = event.window?.contentView?.bounds.height else { return false }
        // SwiftUI's global space is the window's, with its origin at the top.
        return frame.contains(CGPoint(x: event.locationInWindow.x, y: height - event.locationInWindow.y))
    }

    private func move(by delta: CGFloat) {
        let before = swipe.answer
        swipe.move(by: delta)
        if before == nil && swipe.answer != nil && settings.haptics {
            NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now)
        }
    }

    private func finish() {
        guard let allow = swipe.answer else {
            withAnimation(.spring(response: 0.3, dampingFraction: 0.7)) { swipe = SwipeToAnswer() }
            return
        }
        withAnimation(.easeIn(duration: 0.15)) { flyOff = (allow ? 1 : -1) * max(frame.width, 400) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { answer(allow) }
        // The card goes away once the relay confirms; if the answer never lands, it comes back.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            flyOff = nil
            swipe = SwipeToAnswer()
        }
    }
}
