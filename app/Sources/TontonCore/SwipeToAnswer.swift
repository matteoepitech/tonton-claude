import CoreGraphics

/// A horizontal trackpad swipe on a permission card: right allows, left denies, a short swipe springs back. Past the
/// threshold the card follows the fingers less and less, so it never flies off before the answer.
public struct SwipeToAnswer: Equatable, Sendable {
    public static let threshold: CGFloat = 80
    /// How much of the movement past the threshold the card still follows.
    static let resistance: CGFloat = 0.3

    private var travel: CGFloat = 0

    public init() {}

    /// Where the card is drawn.
    public var offset: CGFloat {
        let excess = abs(travel) - Self.threshold
        return excess <= 0 ? travel : (Self.threshold + excess * Self.resistance) * (travel < 0 ? -1 : 1)
    }

    /// From 0 to 1, how close the swipe is to answering.
    public var progress: CGFloat { min(abs(travel) / Self.threshold, 1) }

    /// The answer if the fingers left the trackpad now: true to allow, false to deny, nil to spring back.
    public var answer: Bool? { abs(travel) < Self.threshold ? nil : travel > 0 }

    /// `delta` follows the fingers: positive to the right.
    public mutating func move(by delta: CGFloat) { travel += delta }
}
