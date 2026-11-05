import Combine
import Foundation
import OSLog
import TontonCore

/// Posts to the webhooks of Settings › Notch when a session finishes or needs the user, like the other alerts: never
/// for hidden machines, during quiet hours or a Focus that silences it. What the post says is set by `Webhook.Privacy`.
@MainActor
final class WebhookNotifier {
    private let store: SessionStore
    private let settings: AppSettings
    private var subscriptions = Set<AnyCancellable>()

    init(store: SessionStore, settings: AppSettings) {
        self.store = store
        self.settings = settings
        store.finished.sink { [weak self] session in self?.post(.finished, session) }.store(in: &subscriptions)
        store.attention.sink { [weak self] session in self?.post(.needsYou, session) }.store(in: &subscriptions)
    }

    private func post(_ event: Webhook.Event, _ session: SessionSummary) {
        let address = event == .finished ? settings.webhookFinished : settings.webhookNeedsYou
        guard let url = Webhook.url(address), !settings.hiddenMachines.contains(session.machine),
            !settings.isQuiet(.of(session.status, finished: event == .finished))
        else { return }
        let privacy = Webhook.Privacy(includeNames: settings.webhookIncludeNames, includeLastMessage: settings.webhookIncludeLastMessage)
        Task {
            // The turn's last answer and its length can come a moment after the status: they are read once they are in.
            if event == .finished { try? await Task.sleep(for: .seconds(2)) }
            let latest = store.sessions.first { $0.id == session.id } ?? session
            let reply = store.entries[session.id]?.last { $0.kind == .assistant }?.text
            await Self.send(Webhook.post(event, latest, privacy: privacy, reply: reply), to: url)
        }
    }

    /// True when the service accepted it.
    @discardableResult
    static func send(_ post: Webhook.Post, to url: URL) async -> Bool {
        var request = URLRequest(url: url, timeoutInterval: 10)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Webhook.body(for: url, post: post)
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if !(200..<300).contains(status) { Logger.app.error("webhook \(url.host ?? "?"): HTTP \(status)") }
            return (200..<300).contains(status)
        } catch {
            Logger.app.error("webhook \(url.host ?? "?"): \(error.localizedDescription)")
            return false
        }
    }
}
