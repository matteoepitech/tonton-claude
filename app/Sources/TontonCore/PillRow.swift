import Foundation

/// The row of session pills under the collapsed notch: fixed-width pills, centered, the last one standing for the rest
/// when they don't all fit.
public struct PillRow: Equatable, Sendable {
    public static let maxPills = 6
    public static let pillWidth: Double = 104
    public static let spacing: Double = 6

    public let sessions: [SessionSummary]
    /// Sessions left out, shown as `+N` on the last pill.
    public let more: Int

    public init(_ sessions: [SessionSummary]) {
        let live = sessions.filter(\.status.isLive)
        if live.count > Self.maxPills {
            self.sessions = Array(live.prefix(Self.maxPills - 1))
            more = live.count - (Self.maxPills - 1)
        } else {
            self.sessions = live
            more = 0
        }
    }

    public var pillCount: Int { sessions.count + (more > 0 ? 1 : 0) }
    public var width: Double { pillCount == 0 ? 0 : Double(pillCount) * Self.pillWidth + Double(pillCount - 1) * Self.spacing }

    /// The pill under `x`, counted from the left edge of the row. Nil between pills and outside the row.
    public func pill(at x: Double) -> Int? {
        guard x >= 0, x < width else { return nil }
        let index = Int(x / (Self.pillWidth + Self.spacing))
        return x - Double(index) * (Self.pillWidth + Self.spacing) <= Self.pillWidth ? index : nil
    }
}
