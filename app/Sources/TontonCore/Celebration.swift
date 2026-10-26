import Foundation

/// How long each session has been at work, to celebrate the long tasks once they are done.
public struct WorkTimer: Sendable {
    private var since: [String: Date] = [:]

    public init() {}

    /// Follows a session's status. When the session goes from working to done, returns how long it worked: approvals and
    /// questions along the way are part of the task.
    public mutating func update(_ session: SessionSummary, previous: SessionStatus?, at now: Date = Date()) -> TimeInterval? {
        switch session.status {
        case .working:
            if since[session.id] == nil { since[session.id] = now }
            return nil
        case .permission, .waiting, .starting:
            return nil
        case .idle:
            defer { since[session.id] = nil }
            guard previous == .working, let start = since[session.id] else { return nil }
            return now.timeIntervalSince(start)
        case .error, .ended, .offline:
            since[session.id] = nil
            return nil
        }
    }
}

/// A burst of confetti falling from the notch: each piece flies off at its own speed and falls.
public enum Confetti {
    public struct Piece: Equatable, Sendable {
        /// Points per second, x to the right and y down.
        public let velocity: CGVector
        public let size: CGSize
        public let spin: Double
        public let color: Int
    }

    public static let duration: TimeInterval = 2.6
    static let gravity: Double = 520

    /// The same seed always gives the same burst.
    public static func pieces(_ count: Int = 70, seed: UInt64, colors: Int) -> [Piece] {
        var random = SplitMix64(seed: seed)
        return (0..<count).map { _ in
            Piece(
                velocity: CGVector(dx: random.next(in: -280...280), dy: random.next(in: -140...200)),
                size: CGSize(width: random.next(in: 6...10), height: random.next(in: 3...5)),
                spin: random.next(in: -9...9),
                color: Int(random.next(in: 0...Double(colors) - 0.001)))
        }
    }

    public struct Placement: Equatable, Sendable {
        public let position: CGPoint
        /// Radians.
        public let angle: Double
        public let opacity: Double
    }

    /// Where a piece is `time` seconds after leaving `origin`, how it is turned and how visible it is.
    public static func placement(of piece: Piece, at time: TimeInterval, from origin: CGPoint) -> Placement {
        let position = CGPoint(
            x: origin.x + piece.velocity.dx * time,
            y: origin.y + piece.velocity.dy * time + gravity * time * time / 2)
        let fade = 0.6
        let opacity = time < duration - fade ? 1 : max(0, (duration - time) / fade)
        return Placement(position: position, angle: piece.spin * time, opacity: opacity)
    }
}

/// A small seeded generator, so a burst can be drawn again identically on every frame.
struct SplitMix64 {
    private var state: UInt64

    init(seed: UInt64) { state = seed }

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }

    mutating func next(in range: ClosedRange<Double>) -> Double {
        range.lowerBound + Double(next() >> 11) / Double(1 << 53) * (range.upperBound - range.lowerBound)
    }
}
