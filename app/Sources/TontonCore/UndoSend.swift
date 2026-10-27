import Foundation

/// How long a message from the notch waits before it goes, so it can be taken back (Settings › General › Undo send).
public enum UndoSendDelay: Int, CaseIterable, Sendable {
    case off = 0
    case three = 3
    case five = 5
    case ten = 10

    public var seconds: TimeInterval { TimeInterval(rawValue) }
    public var label: String { self == .off ? String(core: "Off") : String(core: "\(rawValue) seconds") }
}

/// A message held in the app before it is sent, with everything needed to put it back in the composer.
public struct HeldMessage: Identifiable, Sendable {
    public let id: UUID
    public let sessionId: String
    public let text: String
    public let images: [OutgoingImage]
    public let sendAt: Date

    /// Whole seconds left, as the bubble counts them down.
    public func secondsLeft(at now: Date) -> Int { max(0, Int((sendAt.timeIntervalSince(now)).rounded(.up))) }
}

/// Messages waiting for their delay, in the order they were sent. Pure: the caller owns the clock and the timer, and sends
/// what `due` or `flush` hands back.
public struct UndoSendQueue: Sendable {
    public private(set) var held: [HeldMessage] = []

    public init() {}

    /// Holds the message, or returns nil when there is no delay: it goes right away.
    public mutating func hold(
        _ text: String, images: [OutgoingImage], to sessionId: String, delay: UndoSendDelay, now: Date = Date()
    ) -> HeldMessage? {
        guard delay != .off else { return nil }
        // A later message never goes before an earlier one of the same session, even if the delay was shortened since.
        let after = held.last { $0.sessionId == sessionId }?.sendAt ?? .distantPast
        let message = HeldMessage(
            id: UUID(), sessionId: sessionId, text: text, images: images, sendAt: max(now.addingTimeInterval(delay.seconds), after))
        held.append(message)
        return message
    }

    /// Takes the message back, if it has not gone yet.
    public mutating func undo(_ id: UUID) -> HeldMessage? {
        guard let index = held.firstIndex(where: { $0.id == id }) else { return nil }
        return held.remove(at: index)
    }

    /// The messages whose time came, in order, removed from the queue.
    public mutating func due(at now: Date = Date()) -> [HeldMessage] {
        let due = held.filter { $0.sendAt <= now }
        held.removeAll { $0.sendAt <= now }
        return due
    }

    /// Everything still held, in order: the app quits or the notch closes, and nothing may be lost.
    public mutating func flush() -> [HeldMessage] {
        defer { held = [] }
        return held
    }

    public func held(for sessionId: String) -> [HeldMessage] { held.filter { $0.sessionId == sessionId } }

    /// When the timer should fire next.
    public var nextDeadline: Date? { held.map(\.sendAt).min() }
}
