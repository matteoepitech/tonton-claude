import SwiftUI
import TontonCore

// Shared UI state between the window controller and the SwiftUI views.
@MainActor
final class NotchState: ObservableObject {
    enum Mode { case collapsed, peek, expanded }

    @Published var mode: Mode = .collapsed
    @Published var pinned = false
    /// Sessions or Music: the window controller saves the choice in the settings. A session opened from Music mode shows
    /// until the notch closes (NotchContentChoice).
    @Published var content = NotchContentChoice(saved: AppSettings.shared.notchContent)
    /// The ⌘K command palette is open over the notch.
    @Published var showPalette = false
    /// ⌘N: the panel that starts a session on a machine.
    @Published var showNewSession = false
    /// The dropdown open over the notch (NotchMenu): one at a time.
    @Published var menu: NotchMenuRequest?
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
    /// Opens the attachment or image under the pointer in Quick Look, for Space.
    var quickLookUnderPointer: (() -> Void)?
    /// The files and images attached to each draft, kept the same way until the message goes.
    var draftAttachments: [String: [Attachment]] = [:]
    /// Wings beside the camera: the optional activity dots (Settings › Notch), a live activity, or the music in Music mode.
    /// Off means the notch is fully hidden at rest.
    @Published var showWings = false
    /// Set by the open session's composer: files dropped anywhere on the conversation go to it.
    var dropFiles: (([NSItemProvider]) -> Void)?
    /// Shown under the notch for a few seconds once unlocked.
    @Published var achievement: Achievement?
    /// A chat item to scroll to and highlight, picked in the search results.
    @Published var jumpTo: String?
    /// The session whose changed files cover its conversation, from the header's files button.
    @Published var filesOf: String?
    /// The session whose pool popover is open in the chat header, from its button or "Join pool…" in the list.
    @Published var poolOf: String?
    /// The clusters panel shows in the right column instead of the chat, from the bottom bar's button.
    @Published var showClusters = false
    /// The session whose cluster popover is open in the chat header, from its button or "Cluster…" in the list.
    @Published var clusterOf: String?
    /// Live sessions as pills under the collapsed notch (Settings › Notch › Session pills).
    @Published var pills = PillRow([])
    /// The pill whose session shows in a card under it, while the pointer rests on it.
    @Published var previewPill: Int?
    static let pillHeight: CGFloat = 20
    /// Between the notch and its pills.
    static let pillGap: CGFloat = 8
    /// ⌃ is held on its own in the open notch: the composer dictates.
    @Published var pushToTalk = false
    /// Wider wings, so the right one fits the time left before a usage limit resets.
    @Published var wingCountdown = false
    /// The session the wings show, widened like the Dynamic Island (Settings › Notch › Live activity).
    @Published var liveActivity: SessionSummary?
    /// The cover and an equalizer in the wings, while music plays in Music mode (NotchWings).
    @Published var musicWings = false
    /// The hero screen fills the right column, from Tonton's ring in the bottom bar.
    @Published var showHero = false
    /// Its page and the item tried on, kept here so they survive the column being rebuilt, as when a first session shows up.
    @Published var heroPage = HeroPage.journal
    @Published var heroPreview: RPG.Item?
    /// The level Tonton just reached, shown for a moment across the notch.
    @Published var levelUp: Int?
    /// "+XP" on its way from a session's row to Tonton's ring.
    @Published var xpFloat: XPFloat?

    static var expandedSize: CGSize { AppSettings.shared.notchSize.size }
    static let peekHeight: CGFloat = 34
    static let wingWidth: CGFloat = 24
    static let countdownWingWidth: CGFloat = 46
    static let liveActivityWingWidth: CGFloat = 130
    /// Room for the cover beside the camera.
    static let musicWingWidth: CGFloat = 30

    var currentWingWidth: CGFloat {
        if liveActivity != nil { return Self.liveActivityWingWidth }
        if musicWings { return Self.musicWingWidth }
        return wingCountdown ? Self.countdownWingWidth : Self.wingWidth
    }

    /// A session opened from the collapsed notch or the keyboard: in Music mode the sessions show until the notch closes.
    func visitSessions() { content = content.openingSession() }
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

/// XP that just arrived, floating from the row of the session whose turn earned it, or from the ring itself when that
/// row is not known.
struct XPFloat: Equatable, Identifiable {
    let id = UUID()
    let xp: Int
    let session: String?
}
