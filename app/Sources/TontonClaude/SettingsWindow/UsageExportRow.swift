import AppKit
import SwiftUI
import TontonCore

/// Settings › Usage › Export: the history as a CSV file, for the range picked (UsageExport).
struct UsageExportRow: View {
    let history: UsageHistory
    @State private var range = UsageExport.Range.lastMonthDays
    @State private var failure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Export as CSV").font(.system(size: 13))
                    Text("One row per day, machine, project and tool.").font(.system(size: 11)).foregroundStyle(Theme.textDim)
                }
                Spacer(minLength: 12)
                ChoiceMenu(
                    selection: range.rawValue, options: UsageExport.Range.allCases.map { ($0.rawValue, $0.label) },
                    onSelect: { range = UsageExport.Range(rawValue: $0) ?? range })
                Button("Export…") { export() }.buttonStyle(ThemeButtonStyle())
            }
            if let failure { Text(failure).font(.system(size: 12)).foregroundStyle(Theme.danger) }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private func export() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.commaSeparatedText]
        panel.nameFieldStringValue = UsageExport.fileName(range)
        guard panel.runAboveNotch() == .OK, let url = panel.url else { return }
        failure = SaveFailure.write(Data(UsageExport.csv(history, range: range).utf8), to: url)
    }
}
