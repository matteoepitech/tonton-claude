import Combine
import Foundation
import OSLog
import TontonCore

/// Settings › Usage's history: records what sessions report while the app runs, and keeps it next to the account.
@MainActor
final class UsageRecorder: ObservableObject {
    @Published private(set) var history: UsageHistory
    private var subscriptions = Set<AnyCancellable>()

    init(sessions: AnyPublisher<[SessionSummary], Never>) {
        history = Self.load()
        // Working sessions report every few seconds: one reading every few seconds is plenty.
        sessions
            .throttle(for: .seconds(5), scheduler: RunLoop.main, latest: true)
            .sink { [weak self] sessions in self?.record(sessions) }
            .store(in: &subscriptions)
    }

    private func record(_ sessions: [SessionSummary]) {
        var next = history
        next.record(sessions)
        let spent = next.entries != history.entries
        history = next
        // A reading that adds nothing only moves the baselines in memory: no need to write the file.
        if spent { save() }
    }

    private static var url: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let directory = support.appendingPathComponent("Tonton Claude")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return directory.appendingPathComponent("usage.json")
    }

    private static func load() -> UsageHistory {
        (try? JSONDecoder().decode(UsageHistory.self, from: Data(contentsOf: url))) ?? UsageHistory()
    }

    private func save() {
        do {
            let data = try JSONEncoder().encode(history)
            FileManager.default.createFile(atPath: Self.url.path, contents: data, attributes: [.posixPermissions: 0o600])
        } catch {
            Logger.app.error("usage history: \(error.localizedDescription)")
        }
    }
}
