import AppKit
import CoreGraphics
import TontonCore

/// Posts the keyboard's media keys, the controls the notch falls back on when Now Playing can't be read: macOS hands them
/// to the app it holds for Now Playing. Posting needs the user's leave, under System Settings › Privacy & Security ›
/// Accessibility (its `PostEvent` service). A protocol, so that no test posts a key.
@MainActor
public protocol MediaKeyPosting: AnyObject {
    /// Tonton may post them. macOS can keep giving the answer it had at launch until the app opens again.
    var allowed: Bool { get }
    /// Shows macOS's alert, which offers to open System Settings. It returns at once, before the user answers.
    func request()
    func post(_ key: MediaKey)
}

@MainActor
public final class SystemMediaKeys: MediaKeyPosting {
    public init() {}

    public var allowed: Bool { CGPreflightPostEventAccess() }

    public func request() { _ = CGRequestPostEventAccess() }

    /// A press and a release, as the keyboard sends them. Without the permission macOS drops them, and says nothing.
    public func post(_ key: MediaKey) {
        for down in [true, false] {
            let event = NSEvent.otherEvent(
                with: .systemDefined, location: .zero, modifierFlags: NSEvent.ModifierFlags(rawValue: UInt(MediaKey.state(down: down))),
                timestamp: 0, windowNumber: 0, context: nil, subtype: MediaKey.subtype, data1: key.data1(down: down), data2: -1)
            event?.cgEvent?.post(tap: .cgSessionEventTap)
        }
    }
}
