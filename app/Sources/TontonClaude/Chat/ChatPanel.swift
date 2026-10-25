import AppKit
import SwiftUI
import TontonCore

struct ChatPanel: View {
    let session: SessionSummary
    @EnvironmentObject var store: SessionStore
    @State private var pendingTexts: [String] = []

    var body: some View {
        let entries = store.entries[session.id] ?? []
        let items = ChatItem.build(from: entries)
        VStack(spacing: 0) {
            ChatHeader(session: session)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(items) { item in
                            ChatItemView(item: item, sessionWorking: session.status == .working)
                        }
                        ForEach(Array(pendingTexts.enumerated()), id: \.offset) { _, text in
                            UserBubble(text: text, images: [], pending: true)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
                .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
                .onChange(of: entries.count) { _, _ in
                    if entries.last?.viaNotch == true { pendingTexts.removeAll() }
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
                }
                .onChange(of: pendingTexts.count) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
            }
            ForEach(session.pendingPermissions) { req in
                PermissionCard(request: req) { allow in store.answer(req, allow: allow, in: session.id) }
                    .padding(.horizontal, 10)
                    .padding(.bottom, 6)
            }
            Composer(session: session) { text, images in
                store.sendPrompt(text, images: images, to: session.id)
                pendingTexts.append(text.isEmpty ? "(\(images.count) image\(images.count == 1 ? "" : "s"))" : text)
            }
        }
    }
}

struct ChatHeader: View {
    let session: SessionSummary
    @EnvironmentObject var store: SessionStore
    @EnvironmentObject var settings: AppSettings

    /// Saves the conversation as Markdown (tool calls as list items, results left out).
    private func export() {
        var md = "# \(session.title ?? session.project)\n\n_\(session.machine) · \(session.cwd)_\n\n"
        for item in ChatItem.build(from: store.entries[session.id] ?? []) {
            switch item {
            case .user(let e): md += "**You:** \(e.text ?? "")\n\n"
            case .assistant(let e): md += "\(e.text ?? "")\n\n"
            case .tool(let call, let result):
                md += "- `\(call.name ?? "tool")` \(call.summary ?? "")\(result?.isError == true ? " (failed)" : "")\n\n"
            case .system(let e): md += "> \(e.text ?? "")\n\n"
            }
        }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.init(filenameExtension: "md")!]
        panel.nameFieldStringValue = "\(session.project)-\(session.id.prefix(8)).md"
        if panel.runAboveNotch() == .OK, let url = panel.url { try? md.write(to: url, atomically: true, encoding: .utf8) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                StatusDot(status: session.status)
                Text(session.project).font(.system(size: 13, weight: .bold))
                Text("· \(session.machine)").font(.system(size: 12)).foregroundStyle(.secondary)
                Spacer()
                if settings.showCosts, let cost = session.costUSD {
                    Text(String(format: "$%.2f", cost)).font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
                }
                Text(session.status.label).font(.system(size: 11)).foregroundStyle(Color(nsColor: session.status.color))
                Button {
                    export()
                } label: {
                    Image(systemName: "square.and.arrow.up").font(.system(size: 11))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Export the conversation as Markdown")
            }
            HStack {
                Text(session.title ?? session.cwd).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                if let err = store.lastError {
                    Text(err).font(.system(size: 10)).foregroundStyle(.red).lineLimit(1)
                        .onTapGesture { store.lastError = nil }
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.white.opacity(0.04))
    }
}
