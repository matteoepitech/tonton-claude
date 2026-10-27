import Charts
import SwiftUI
import TontonCore

/// The last 7 days of cost and tokens, as recorded on this Mac: per day, per machine and per project. Then the hours
/// Claude works and the month's recap.
struct UsagePane: View {
    @ObservedObject var usage: UsageRecorder

    private static let days = 7
    private static let projects = 8

    var body: some View {
        let daily = usage.history.daily(Self.days)
        let machines = usage.history.totals(by: \.machine, days: Self.days)
        VStack(alignment: .leading, spacing: 0) {
            if machines.isEmpty {
                Card {
                    VStack(spacing: 10) {
                        IconTile(systemName: "chart.bar.xaxis", size: 40)
                        Text("Nothing recorded yet").font(.system(size: 14, weight: .medium))
                        Text("Cost and tokens add up here while sessions run and Tonton Claude is open.")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.textDim)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 40)
                }
            } else {
                summary(machines)
                Card(padding: 16) { chart(daily) }
                GroupLabel(text: "By machine")
                Card { rows(machines) }
                GroupLabel(text: "By project")
                Card { rows(Array(usage.history.totals(by: \.project, days: Self.days).prefix(Self.projects))) }
                let tools = usage.history.totals(by: \.toolName, days: Self.days)
                if tools.count > 1 {
                    GroupLabel(text: "By tool")
                    Card { rows(tools) }
                }
            }
            // The whole history, not only these 7 days: shown even when they are empty.
            if !usage.history.entries.isEmpty {
                GroupLabel(text: "Export")
                Card { UsageExportRow(history: usage.history) }
            }
            let grid = usage.hours.grid()
            if BusyHours.busiest(grid) != nil {
                GroupLabel(text: "When Claude works")
                Card(padding: 16) { BusyHoursMap(grid: grid) }
            }
            WrappedSection(usage: usage)
            Text(
                "Counted on this Mac from what sessions report while Tonton Claude runs. Costs are Claude Code's estimates at "
                    + "list price; tokens include what was read from and written to the prompt cache. Wrapped and the hours count "
                    + "the time of the tasks seen finishing, and Wrapped the tool calls of the conversations opened in the notch or "
                    + "kept on this Mac."
            )
            .font(.system(size: 12))
            .foregroundStyle(Theme.textFaint)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 12)
        }
    }

    private func summary(_ machines: [(name: String, costUSD: Double, tokens: TokenCounts)]) -> some View {
        let cost = machines.map(\.costUSD).reduce(0, +)
        let tokens = machines.map(\.tokens).reduce(TokenCounts(), +)
        return HStack(alignment: .firstTextBaseline, spacing: 28) {
            figure(String(format: "$%.2f", cost), "last 7 days")
            figure(TokenCounts.short(tokens.allInput), "tokens in")
            figure(TokenCounts.short(tokens.output), "tokens out")
            Spacer()
        }
        .padding(.bottom, 16)
    }

    private func figure(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value).font(.system(size: 22, weight: .semibold, design: .rounded)).monospacedDigit()
            Text(label).font(.system(size: 11)).foregroundStyle(Theme.textDim)
        }
    }

    /// Cost per day, stacked by machine.
    private func chart(_ daily: [(day: Date, entries: [UsageHistory.Entry])]) -> some View {
        Chart {
            ForEach(daily, id: \.day) { day in
                ForEach(Dictionary(grouping: day.entries, by: \.machine).sorted { $0.key < $1.key }, id: \.key) { machine, entries in
                    BarMark(x: .value("Day", day.day, unit: .day), y: .value("Cost", entries.map(\.costUSD).reduce(0, +)))
                        .foregroundStyle(by: .value("Machine", machine))
                        .cornerRadius(3)
                }
            }
        }
        .chartXAxis {
            AxisMarks(values: .stride(by: .day)) { _ in
                AxisValueLabel(format: .dateTime.weekday(.abbreviated), centered: true)
            }
        }
        .chartYAxis {
            AxisMarks { value in
                AxisGridLine().foregroundStyle(Theme.border)
                AxisValueLabel { Text(String(format: "$%.0f", value.as(Double.self) ?? 0)) }
            }
        }
        .chartLegend(position: .bottom, alignment: .leading)
        .frame(height: 190)
    }

    @ViewBuilder private func rows(_ totals: [(name: String, costUSD: Double, tokens: TokenCounts)]) -> some View {
        ForEach(Array(totals.enumerated()), id: \.element.name) { index, total in
            if index > 0 { Hairline() }
            HStack(spacing: 12) {
                Text(total.name).font(.system(size: 13)).lineLimit(1)
                Spacer(minLength: 12)
                Text("\(TokenCounts.short(total.tokens.allInput)) in · \(TokenCounts.short(total.tokens.output)) out")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Theme.textDim)
                Text(String(format: "$%.2f", total.costUSD))
                    .font(.system(size: 12, design: .monospaced))
                    .frame(minWidth: 64, alignment: .trailing)
            }
            .padding(.horizontal, 16)
            .frame(height: 40)
        }
    }
}
