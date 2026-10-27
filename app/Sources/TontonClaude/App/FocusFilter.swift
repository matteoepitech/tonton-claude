import AppIntents
import TontonCore

/// The app's Focus filter: added to a Focus in System Settings › Focus, it silences the alerts it names while that Focus
/// is on. macOS calls `perform` when the Focus turns on, and again with the default values when it turns off, so the
/// defaults silence nothing; the suggested filter silences everything. macOS finds the filter in the app's
/// Metadata.appintents, which scripts/build-app.sh makes.
struct SilenceAlertsFilter: SetFocusFilterIntent {
    static let title: LocalizedStringResource = "Silence Tonton Claude"
    static let description: IntentDescription? = """
        Choose which alerts stay quiet during this Focus. The notch still shows the sessions that wait for you.
        """

    @Parameter(title: "Finished tasks", default: false) var finished: Bool
    @Parameter(title: "Questions and errors", default: false) var needsYou: Bool
    @Parameter(title: "Permission requests", default: false) var permission: Bool
    @Parameter(title: "Usage limit resets", default: false) var limitReset: Bool
    @Parameter(title: "Budgets, achievements and the daily summary", default: false) var other: Bool

    var silence: FocusSilence {
        let picked: [(FocusSilence.Event, Bool)] = [
            (.finished, finished), (.needsYou, needsYou), (.permission, permission), (.limitReset, limitReset), (.other, other),
        ]
        return FocusSilence(events: Set(picked.filter(\.1).map(\.0)))
    }

    var displayRepresentation: DisplayRepresentation {
        // Already in the app's language: a key of its own would only find itself.
        DisplayRepresentation(title: LocalizedStringResource(stringLiteral: silence.summary))
    }

    static func suggestedFocusFilters(for context: FocusFilterSuggestionContext) async -> [SilenceAlertsFilter] {
        let all = SilenceAlertsFilter()
        all.finished = true
        all.needsYou = true
        all.permission = true
        all.limitReset = true
        all.other = true
        return [all]
    }

    func perform() async throws -> some IntentResult {
        let silence = silence
        await MainActor.run { AppSettings.shared.focusSilence = silence }
        return .result()
    }

    /// At launch: a Focus may have turned on while the app was not running.
    static func readCurrent() {
        Task {
            guard let filter = try? await SilenceAlertsFilter.current else { return }
            let silence = filter.silence
            await MainActor.run { AppSettings.shared.focusSilence = silence }
        }
    }
}
