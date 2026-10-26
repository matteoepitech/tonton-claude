import Foundation

/// Which closed and offline sessions the list shows: Settings › General › Hide finished sessions, and the eye button above
/// the list. Live sessions always show.
public enum FinishedSessions {
    /// `hideFinishedAfterHours` for "right away": a session leaves the list as soon as it closes.
    public static let rightAway = -1

    /// `hours`: 0 keeps finished sessions, `rightAway` hides them, more hides them that long after their last activity.
    public static func isShown(_ session: SessionSummary, hideAfterHours hours: Int, now: Date = Date()) -> Bool {
        guard !session.status.isLive else { return true }
        if hours == rightAway { return false }
        return hours <= 0 || now.timeIntervalSince(session.lastActivity) < Double(hours) * 3600
    }

    /// The setting after a click on the eye button: hide them all now, or go back to what it was before.
    public static func toggled(_ hours: Int, previous: Int) -> Int {
        hours == rightAway ? (previous == rightAway ? 0 : previous) : rightAway
    }
}
