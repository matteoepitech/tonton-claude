import SwiftUI
import TontonCore

// Shared UI state between the window controller and the SwiftUI views.
@MainActor
final class NotchState: ObservableObject {
    enum Mode { case collapsed, peek, expanded }

    @Published var mode: Mode = .collapsed
    @Published var pinned = false
    @Published var peekSession: SessionSummary?
    /// Shown in the banner instead of the session's status.
    @Published var peekText: String?
    /// Set while confetti falls from the notch, to the seed of the burst.
    @Published var confetti: UInt64?
    @Published var notchSize = CGSize(width: 200, height: 32)
    @Published var hasPhysicalNotch = false
    /// Unsent text per session, kept when the notch closes or the selection changes. Not published: a keystroke must only
    /// redraw the composer, not the whole notch.
    var drafts: [String: String] = [:]
    /// Optional activity dots beside the camera (Settings › Notch); off means the notch is fully hidden at rest.
    @Published var showWings = false
    /// Set by the open session's composer: files dropped anywhere on the conversation go to it.
    var dropFiles: (([NSItemProvider]) -> Void)?
    /// Shown under the notch for a few seconds once unlocked.
    @Published var achievement: Achievement?
    /// A chat item to scroll to and highlight, picked in the search results.
    @Published var jumpTo: String?
    /// Wider wings, so the right one fits the time left before a usage limit resets.
    @Published var wingCountdown = false
    /// The session the wings show, widened like the Dynamic Island (Settings › Notch › Live activity).
    @Published var liveActivity: SessionSummary?

    static var expandedSize: CGSize { AppSettings.shared.notchSize.size }
    static let peekHeight: CGFloat = 34
    static let wingWidth: CGFloat = 24
    static let countdownWingWidth: CGFloat = 46
    static let liveActivityWingWidth: CGFloat = 130

    var currentWingWidth: CGFloat {
        liveActivity != nil ? Self.liveActivityWingWidth : wingCountdown ? Self.countdownWingWidth : Self.wingWidth
    }
    /// At rest the shape is exactly the camera housing, so nothing shows (unless activity dots are on).
    var collapsedSize: CGSize { CGSize(width: notchSize.width + (showWings ? currentWingWidth * 2 : 0), height: notchSize.height) }
    var peekSize: CGSize { CGSize(width: max(collapsedSize.width, 380), height: notchSize.height + Self.peekHeight) }

    var currentSize: CGSize {
        switch mode {
        case .collapsed: collapsedSize
        case .peek: peekSize
        case .expanded: Self.expandedSize
        }
    }
}
