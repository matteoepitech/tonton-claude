import Combine
import Foundation
import OSLog
import TontonCore

/// Posts to the webhooks of Settings › Notch when a session finishes or needs the user, like the other alerts: never
/// for hidden machines or during quiet hours. What the message says is set by `Webhook.Privacy`.
@MainActor
final class WebhookNotifier {
    private let settings: AppSettings
    private var subscriptions = Set<AnyCancellable>()

    init(store: SessionStore, settings: AppSettings) {
        self.settings = settings
        store.finished.sink { [weak self] session in self?.post(.finished, session) }.store(in: &subscriptions)
        store.attention.sink { [weak self] session in self?.post(.needsYou, session) }.store(in: &subscriptions)
    }

    private func post(_ event: Webhook.Event, _ session: SessionSummary) {
        let address = event == .finished ? settings.webhookFinished : settings.webhookNeedsYou
        guard let url = Webhook.url(address), !settings.hiddenMachines.contains(session.machine), !settings.isQuietNow else { return }
        let privacy = Webhook.Privacy(includeNames: settings.webhookIncludeNames, includeLastMessage: settings.webhookIncludeLastMessage)
        let message = Webhook.message(event, session, privacy: privacy)
        Task { await Self.send(message, to: url) }
    }

    /// True when the service accepted it.
    @discardableResult
    static func send(_ message: String, to url: URL) async -> Bool {
        var request = URLRequest(url: url, timeoutInterval: 10)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Webhook.body(for: url, message: message)
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
