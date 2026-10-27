import AppKit
import SwiftUI
import TontonCore

/// The end of a machine's agent log, under its row in Settings › Machines, read again on request.
struct AgentLogPanel: View {
    let machine: MachineInfo
    let request: AgentLogRequest
    let refresh: () -> Void
    let close: () -> Void
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text("Agent log").font(.system(size: 12, weight: .medium))
                Text(caption).font(.system(size: 11.5)).foregroundStyle(Theme.textFaint).lineLimit(1)
                Spacer(minLength: 8)
                if request.isLoading { ProgressView().controlSize(.small) }
                PanelIconButton(symbol: "arrow.clockwise", help: "Read the log again", action: refresh).disabled(request.isLoading)
                PanelIconButton(symbol: copied ? "checkmark" : "doc.on.doc", help: "Copy the lines", action: copy).disabled(lines.isEmpty)
                PanelIconButton(symbol: "xmark", help: "Close the log", action: close)
            }
            if case .failed(let text) = request.state {
                Text(text).font(.system(size: 12)).foregroundStyle(Theme.danger).fixedSize(horizontal: false, vertical: true)
            }
            if let log = request.answer {
                if log.lines.isEmpty {
                    Text("The log is empty.").font(.system(size: 12)).foregroundStyle(Theme.textDim)
                } else {
                    AgentLogLines(lines: log.lines, truncated: log.truncated)
                }
            }
            Text("What the agent did on \(machine.name), never what Claude wrote. Keys and tokens are taken out before it leaves.")
                .font(.system(size: 11.5))
                .foregroundStyle(Theme.textFaint)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var caption: String {
        guard let log = request.answer else { return request.isLoading ? String(localized: "Asking \(machine.name)…") : "" }
        let count = String(localized: "Last \(log.lines.count) lines")
        let size = ByteCountFormatter.string(fromByteCount: Int64(log.size), countStyle: .file)
        let caption = String(localized: "\(count) of \(size)", comment: "Last 40 lines of 12 KB")
        guard let read = log.readAt else { return caption }
        return String(localized: "\(caption) · read at \(read.formatted(date: .omitted, time: .shortened))")
    }

    private var lines: [String] { request.answer?.lines ?? [] }

    private func copy() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(lines.joined(separator: "\n"), forType: .string)
        copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
    }
}

/// The small square buttons in the header of the panels under a machine's row.
struct PanelIconButton: View {
    let symbol: String
    let help: LocalizedStringKey
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 11))
                .foregroundStyle(Theme.textDim)
                .frame(width: 24, height: 24)
                .background(RoundedRectangle(cornerRadius: 6).fill(Theme.raised))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.border))
        }
        .buttonStyle(.plain)
        .help(help)
    }
}

/// The lines in a box that scrolls, the newest at the bottom, where it opens.
struct AgentLogLines: View {
    let lines: [String]
    let truncated: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                AgentLogText(lines: lines, truncated: truncated).padding(10)
            }
            .frame(height: 240)
            .background(RoundedRectangle(cornerRadius: 7).fill(Theme.bg))
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(Theme.border))
            .onAppear { proxy.scrollTo(lines.count - 1, anchor: .bottom) }
            .onChange(of: lines) { proxy.scrollTo(lines.count - 1, anchor: .bottom) }
        }
    }
}

/// One row per line: when, dimmed, then what the agent did.
struct AgentLogText: View {
    let lines: [String]
    let truncated: Bool

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 3) {
            if truncated {
                Text("Earlier lines are left out.").font(.system(size: 11)).foregroundStyle(Theme.textFaint).padding(.bottom, 4)
            }
            ForEach(Array(lines.enumerated()), id: \.offset) { index, raw in
                let line = AgentLogLine(raw)
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(line.date.map(Self.time) ?? "").foregroundStyle(Theme.textFaint).frame(width: 64, alignment: .leading)
                    Text(line.message).foregroundStyle(Theme.textDim).frame(maxWidth: .infinity, alignment: .leading)
                }
                .font(.system(size: 11, design: .monospaced))
                .textSelection(.enabled)
                .id(index)
            }
        }
    }

    /// The time for today's lines, the day too for older ones.
    private static func time(_ date: Date) -> String {
        Calendar.current.isDateInToday(date)
            ? date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).second(.twoDigits))
            : date.formatted(.dateTime.month(.abbreviated).day())
    }
}
