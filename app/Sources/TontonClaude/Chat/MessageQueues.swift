import Combine
import Foundation
import TontonCore

/// The message queue of every session (see MessageQueue), kept while the app runs. Watches the sessions and sends the
/// next queued message when its session is done with a turn.
@MainActor
final class MessageQueues: ObservableObject {
    static let shared = MessageQueues()

    @Published private(set) var queues: [String: MessageQueue] = [:]
    private weak var store: SessionStore?
    private var subscription: AnyCancellable?

    func attach(_ store: SessionStore) {
        self.store = store
        subscription = store.sessionsPublisher.sink { [weak self] sessions in self?.dispatch(sessions) }
    }

    func items(for sessionId: String) -> [QueuedMessage] { queues[sessionId]?.items ?? [] }

    func add(_ message: QueuedMessage, to sessionId: String) {
        queues[sessionId, default: MessageQueue()].append(message)
        if let store { dispatch(store.sessions) }
    }

    func remove(_ id: UUID, from sessionId: String) { queues[sessionId]?.remove(id) }

    func move(_ id: UUID, by offset: Int, in sessionId: String) { queues[sessionId]?.move(id, by: offset) }

    private func dispatch(_ sessions: [SessionSummary]) {
        for session in sessions where queues[session.id]?.isEmpty == false {
            guard let message = queues[session.id]?.next(status: session.status, canChat: session.canChat) else { continue }
            store?.sendPrompt(message.text, images: message.images, to: session.id)
        }
        // Sessions that went away take their queue with them.
        let ids = Set(sessions.map(\.id))
        for id in queues.keys where !ids.contains(id) { queues[id] = nil }
    }
}
