import Foundation

/// Tonton, the pixel character of the collapsed notch: he types while Claude works, sleeps when it is done and raises a
/// hand when a session needs the user. Each pose is a few 12×12 frames played in a loop.
public enum Mascot {
    public enum Pose: Equatable, Sendable {
        case typing, sleeping, raisingHand
    }

    public static let size = 12

    public static func pose(for status: SessionStatus) -> Pose {
        switch status {
        case .working, .starting: .typing
        case .permission, .waiting, .error: .raisingHand
        case .idle, .ended, .offline: .sleeping
        }
    }

    /// One string per row. `#` body, `o` eye, `-` closed eye, `h` hand, `k` keyboard, `z` a snore, `.` nothing.
    public static func frames(_ pose: Pose) -> [[String]] {
        switch pose {
        case .typing: [typing(left: true), typing(left: false)]
        case .sleeping: [sleeping(high: true), sleeping(high: false)]
        case .raisingHand: [raising(up: true), raising(up: false)]
        }
    }

    private static let head = [
        "............",
        "....####....",
        "...######...",
        "..########..",
    ]

    private static func typing(left: Bool) -> [String] {
        head + [
            "..#oo##oo#..",
            "..#oo##oo#..",
            "..########..",
            "...######...",
            left ? "..h......h.." : "...h....h...",
            "kkkkkkkkkkkk",
            "............",
            "............",
        ]
    }

    private static func sleeping(high: Bool) -> [String] {
        [
            high ? "..........z." : "............",
            high ? "....####...z" : "....####..z.",
            "...######...",
            "..########..",
            "..########..",
            "..#--##--#..",
            "..########..",
            "...######...",
            "............",
            "............",
            "............",
            "............",
        ]
    }

    private static func raising(up: Bool) -> [String] {
        [
            up ? "..........h." : "............",
            up ? "....####..h." : "....####...h",
            up ? "...######.h." : "...######.h.",
            "..########h.",
            "..#oo##oo#..",
            "..#oo##oo#..",
            "..########..",
            "...######...",
            "............",
            "............",
            "............",
            "............",
        ]
    }
}
