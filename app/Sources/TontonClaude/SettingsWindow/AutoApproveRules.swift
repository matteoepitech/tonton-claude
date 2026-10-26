import SwiftUI
import TontonCore

/// Tool calls the agents approve without asking: a tool, a pattern, and the machines it applies to.
struct AutoApproveRules: View {
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var store: SessionStore
    @State private var tool = "Bash"
    @State private var pattern = ""
    @State private var machineId = ""

    var body: some View {
        GroupLabel(text: "Auto-approve")
        Card {
            ForEach(settings.autoApproveRules) { rule in
                HStack(spacing: 10) {
                    Text(rule.tool).font(.system(size: 13, weight: .medium)).frame(width: 84, alignment: .leading)
                    Text(rule.pattern.isEmpty ? "any call" : rule.pattern)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(rule.pattern.isEmpty ? Theme.warning : Theme.text)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 12)
                    Text(machineName(rule.machineId)).font(.system(size: 12)).foregroundStyle(Theme.textDim).lineLimit(1)
                    Button {
                        change { $0.removeAll { $0.id == rule.id } }
                    } label: {
                        Image(systemName: "trash").font(.system(size: 11))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.textDim)
                    .help("Remove this rule")
                }
                .padding(.horizontal, 16)
                .frame(height: 40)
                Hairline()
            }
            HStack(spacing: 8) {
                ChoiceMenu(selection: tool, options: AutoApproveRule.tools.map { ($0, $0) }) { tool = $0 }
                ThemeField(
                    placeholder: tool == "Bash" || tool == "PowerShell" ? "npm test *" : "pattern, empty for any call", text: $pattern
                )
                .onSubmit(add)
                ChoiceMenu(selection: machineId, options: [("", "All machines")] + store.machines.map { ($0.id, $0.name) }) {
                    machineId = $0
                }
                Button("Add", action: add).buttonStyle(ThemeButtonStyle())
            }
            .padding(12)
        }
        Text(
            "Matching calls are approved on those machines without asking, in the terminal or the notch. * stands for anything: "
                + "npm run *. A command chained with ; && | or $( ) only passes a rule that spells it out in full."
        )
        .font(.system(size: 12))
        .foregroundStyle(Theme.textFaint)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, 10)
    }

    private func add() {
        let rule = AutoApproveRule(
            tool: tool, pattern: pattern.trimmingCharacters(in: .whitespacesAndNewlines), machineId: machineId.isEmpty ? nil : machineId)
        change { $0.append(rule) }
        pattern = ""
    }

    /// Every change dates the set, so agents replace theirs.
    private func change(_ edit: (inout [AutoApproveRule]) -> Void) {
        edit(&settings.autoApproveRules)
        settings.autoApproveRulesDate = Date()
    }

    private func machineName(_ id: String?) -> String {
        guard let id else { return "All machines" }
        return store.machines.first { $0.id == id }?.name ?? "A removed machine"
    }
}
