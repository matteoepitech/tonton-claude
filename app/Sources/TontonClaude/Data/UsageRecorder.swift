import Combine
import Foundation
import OSLog
import TontonCore

enum BudgetPeriod { case day, month }

/// Settings › Usage's history: records what sessions report while the app runs, and keeps it next to the account.
@MainActor
final class UsageRecorder: ObservableObject {
    @Published private(set) var history: UsageHistory
    /// The monthly recap.
    @Published private(set) var wrapped: WrappedLog
    /// When Claude works, for the heat map.
    @Published private(set) var hours: BusyHours
    /// The turns counted in both, seen ending here or reported later by the agents.
    private var turns: TurnLedger
    /// Spending went past the daily budget (once a day) or the monthly one (once a month), with what was spent so far.
    let budgetExceeded = PassthroughSubject<(period: BudgetPeriod, spent: Double), Never>()
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
        turns = Self.load(TurnLedger.self, from: "turns.json") ?? TurnLedger()
        // Working sessions report every few seconds: one reading every few seconds is plenty.
        sessions
            .throttle(for: .seconds(5), scheduler: RunLoop.main, latest: true)
            .sink { [weak self] sessions in self?.record(sessions) }
            .store(in: &subscriptions)
        tasks
            .sink { [weak self] task in
                guard let self else { return }
                let now = Date()
                let counted = turns.live(session: task.session.id, end: now)
                save(turns, to: "turns.json")
                // The agent already reported this turn: it was counted then.
                guard counted else { return }
                worked(task.worked, by: task.session, until: now)
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

    private func worked(_ seconds: TimeInterval, by session: SessionSummary, until end: Date) {
        wrapped.worked(seconds, session: session.id, project: session.project, at: end)
        saveWrapped()
        hours.worked(seconds, until: end)
        save(hours, to: "hours.json")
    }

    /// Turns the agents report that this Mac didn't see end, while it was asleep or the app closed: they count at their
    /// own time.
    private func countReportedTurns(_ sessions: [SessionSummary]) {
        var counted = false
        for session in sessions {
            guard let reported = session.turns, !reported.isEmpty else { continue }
            for turn in turns.reported(session: session.id, turns: reported) {
                worked(turn.seconds, by: session, until: turn.end)
                counted = true
            }
        }
        if counted { save(turns, to: "turns.json") }
    }

    private func record(_ sessions: [SessionSummary]) {
        countReportedTurns(sessions)
        var next = history
        next.record(sessions)
        let spent = next.entries != history.entries
        history = next
        // A reading that adds nothing only moves the baselines in memory: no need to write the file.
        guard spent else { return }
        save(history, to: "usage.json")
        let now = Date()
        let today = UsageHistory.day(now)
        let spentToday = history.spent(on: now)
        if DailyBudget.shouldAlert(
            spent: spentToday, budget: Double(settings.dailyBudget), lastAlertDay: settings.budgetAlertDay, today: today)
        {
            settings.budgetAlertDay = today
            budgetExceeded.send((.day, spentToday))
        }
        let month = WrappedLog.month(now)
        let spentThisMonth = history.spent(inMonth: month)
        if MonthlyBudget.shouldAlert(
            spent: spentThisMonth, budget: Double(settings.monthlyBudget), lastAlertMonth: settings.budgetAlertMonth, month: month)
        {
            settings.budgetAlertMonth = month
            budgetExceeded.send((.month, spentThisMonth))
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
