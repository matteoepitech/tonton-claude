import Foundation

/// A message waiting for Claude to finish its turn.
public struct QueuedMessage: Identifiable, Sendable {
    public let id = UUID()
    public let text: String
    public let images: [OutgoingImage]

    public init(text: String, images: [OutgoingImage] = []) {
        self.text = text
        self.images = images
    }
}

/// The messages queued for one session, sent one per turn: the first when the session is done, the next once that one
/// started a turn and the turn ended. Never two at once.
public struct MessageQueue: Sendable {
    public private(set) var items: [QueuedMessage] = []
    /// When the last message left, until its turn is seen starting.
    private var sentAt: Date?
    /// Past this, a turn that was never seen starting no longer holds the queue.
    static let turnStartTimeout: TimeInterval = 60

    public init() {}

    public var isEmpty: Bool { items.isEmpty }

    public mutating func append(_ message: QueuedMessage) { items.append(message) }

    public mutating func remove(_ id: UUID) { items.removeAll { $0.id == id } }

    /// Moves a message one place earlier (-1) or later (+1).
    public mutating func move(_ id: UUID, by offset: Int) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        let target = index + offset
        guard items.indices.contains(target) else { return }
        items.swapAt(index, target)
    }

    /// The message to send now, if any.
    public mutating func next(status: SessionStatus, canChat: Bool, now: Date = Date()) -> QueuedMessage? {
        if let sentAt {
            guard status == .working || now.timeIntervalSince(sentAt) > Self.turnStartTimeout else { return nil }
            self.sentAt = nil
        }
        guard canChat, status == .idle, !items.isEmpty else { return nil }
        sentAt = now
        return items.removeFirst()
    }
}
