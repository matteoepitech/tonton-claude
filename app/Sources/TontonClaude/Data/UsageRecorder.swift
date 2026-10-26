import Combine
import Foundation
import OSLog
import TontonCore

/// Settings › Usage's history: records what sessions report while the app runs, and keeps it next to the account.
@MainActor
final class UsageRecorder: ObservableObject {
    @Published private(set) var history: UsageHistory
    /// The monthly recap.
    @Published private(set) var wrapped: WrappedLog
    /// When Claude works, for the heat map.
    @Published private(set) var hours: BusyHours
    /// Today's spending went past the daily budget, with what was spent so far. Once a day.
    let budgetExceeded = PassthroughSubject<Double, Never>()
    private let settings: AppSettings
    private var subscriptions = Set<AnyCancellable>()

    init(
        sessions: AnyPublisher<[SessionSummary], Never>, tasks: AnyPublisher<(session: SessionSummary, worked: TimeInterval), Never>,
        entries: AnyPublisher<[String: [Entry]], Never>, settings: AppSettings
    ) {
        self.settings = settings
        history = Self.load(UsageHistory.self, from: "usage.json") ?? UsageHistory()
        wrapped = Self.load(WrappedLog.self, from: "wrapped.json") ?? WrappedLog()
        hours = Self.load(BusyHours.self, from: "hours.json") ?? BusyHours()
        // Working sessions report every few seconds: one reading every few seconds is plenty.
        sessions
            .throttle(for: .seconds(5), scheduler: RunLoop.main, latest: true)
            .sink { [weak self] sessions in self?.record(sessions) }
            .store(in: &subscriptions)
        tasks
            .sink { [weak self] task in
                guard let self else { return }
                wrapped.worked(task.worked, session: task.session.id, project: task.session.project)
                saveWrapped()
                hours.worked(task.worked, until: Date())
                save(hours, to: "hours.json")
            }
            .store(in: &subscriptions)
        // Conversations grow with each entry: counting the calls once things settle is enough.
        entries
            .debounce(for: .seconds(5), scheduler: RunLoop.main)
            .sink { [weak self] entries in
                guard let self, wrapped.count(entries) else { return }
                saveWrapped()
            }
            .store(in: &subscriptions)
    }

    private func record(_ sessions: [SessionSummary]) {
        var next = history
        next.record(sessions)
        let spent = next.entries != history.entries
        history = next
        // A reading that adds nothing only moves the baselines in memory: no need to write the file.
        guard spent else { return }
        save(history, to: "usage.json")
        let today = UsageHistory.day(Date())
        let spentToday = history.spent(on: Date())
        if DailyBudget.shouldAlert(
            spent: spentToday, budget: Double(settings.dailyBudget), lastAlertDay: settings.budgetAlertDay, today: today)
        {
            settings.budgetAlertDay = today
            budgetExceeded.send(spentToday)
        }
    }

    private func saveWrapped() { save(wrapped, to: "wrapped.json") }

    private static func url(_ name: String) -> URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let directory = support.appendingPathComponent("Tonton Claude")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return directory.appendingPathComponent(name)
    }

    private static func load<T: Decodable>(_ type: T.Type, from name: String) -> T? {
        try? JSONDecoder().decode(type, from: Data(contentsOf: url(name)))
    }

    private func save(_ value: some Encodable, to name: String) {
        do {
            let data = try JSONEncoder().encode(value)
            FileManager.default.createFile(atPath: Self.url(name).path, contents: data, attributes: [.posixPermissions: 0o600])
        } catch {
            Logger.app.error("usage history: \(error.localizedDescription)")
        }
    }
}
