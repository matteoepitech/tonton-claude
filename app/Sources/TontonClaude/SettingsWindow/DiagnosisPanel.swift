import SwiftUI
import TontonCore

/// How a machine is set up, under its row in Settings › Machines: what its agent checked, and a repair button where one
/// is safe to run from here.
struct DiagnosisPanel<Update: View>: View {
    let machine: MachineInfo
    let request: DiagnosisRequest
    /// The repair running on the machine, until its diagnosis comes back.
    let repairing: String?
    let run: (_ fix: String?) -> Void
    let close: () -> Void
    /// The agent update button, on the agent's own line.
    @ViewBuilder let update: () -> Update

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text("Diagnosis").font(.system(size: 12, weight: .medium))
                Text(caption).font(.system(size: 11.5)).foregroundStyle(Theme.textFaint).lineLimit(1)
                Spacer(minLength: 8)
                if request.isLoading { ProgressView().controlSize(.small) }
                PanelIconButton(symbol: "arrow.clockwise", help: "Check again", action: { run(nil) }).disabled(request.isLoading)
                PanelIconButton(symbol: "xmark", help: "Close the diagnosis", action: close)
            }
            if case .failed(let text) = request.state {
                Text(text).font(.system(size: 12)).foregroundStyle(Theme.danger).fixedSize(horizontal: false, vertical: true)
            }
            if let diagnosis = request.answer {
                if let fixed = diagnosis.fixed, !request.isLoading {
                    Label(fixed.text, systemImage: fixed.ok ? "checkmark" : "xmark")
                        .font(.system(size: 12))
                        .foregroundStyle(fixed.ok ? Theme.success : Theme.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(diagnosis.checks) { check in row(check) }
                }
            }
            Text("Repairs redo one step of the install on \(machine.name). Nothing else on the machine changes.")
                .font(.system(size: 11.5))
                .foregroundStyle(Theme.textFaint)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private func row(_ check: Diagnosis.Check) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: check.ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .font(.system(size: 11.5))
                .foregroundStyle(check.ok ? Theme.success : Theme.warning)
                .frame(width: 14)
            VStack(alignment: .leading, spacing: 2) {
                Text(check.label).font(.system(size: 12, weight: .medium))
                Text(check.detail)
                    .font(.system(size: 11.5))
                    .foregroundStyle(Theme.textDim)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            if let fix = check.fix {
                if repairing == fix && request.isLoading {
                    ProgressView().controlSize(.small).frame(width: 60)
                } else {
                    Button("Repair") { run(fix) }
                        .buttonStyle(ThemeButtonStyle())
                        .disabled(request.isLoading)
                        .help(Self.help(fix))
                }
            } else if check.id == "agent" {
                update()
            }
        }
    }

    private var caption: String {
        guard let diagnosis = request.answer else { return request.isLoading ? String(localized: "Asking \(machine.name)…") : "" }
        let issues = diagnosis.failing.count
        let summary = issues == 0 ? String(localized: "All good") : String(localized: "\(issues) to look at")
        let caption = String(localized: "\(summary) · agent \(diagnosis.version)", comment: "The agent's version")
        guard let checked = diagnosis.checkedAt else { return caption }
        return String(localized: "\(caption) · checked at \(checked.formatted(date: .omitted, time: .shortened))")
    }

    /// What each repair does on the machine, before the user asks for it.
    static func help(_ fix: String) -> String {
        switch fix {
        case "service": String(localized: "Registers the background service at login and starts it on the installed agent.")
        case "hooks": String(localized: "Adds the Tonton Claude hooks to ~/.claude/settings.json, keeping everything else.")
        case "mcp": String(localized: "Registers the tonton MCP server with claude mcp add.")
        case "launcher": String(localized: "Writes the claude launcher into the shell profiles again.")
        case "statusline": String(localized: "Writes the status line settings the launcher passes to claude.")
        case "opencode": String(localized: "Writes the Tonton plugin into OpenCode's plugins folder.")
        default: String(localized: "Runs this repair on the machine.")
        }
    }
}
