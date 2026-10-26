import AppKit
import SwiftUI
import TontonCore

struct ChatPanel: View {
    let session: SessionSummary
    @EnvironmentObject var store: SessionStore
    @EnvironmentObject var state: NotchState
    @State private var pendingTexts: [String] = []
    /// The item a search jumped to, highlighted for a moment.
    @State private var highlighted: String?

    var body: some View {
        let entries = store.entries[session.id] ?? []
        let items = ChatItem.build(from: entries)
        let delivered = entries.filter { $0.viaNotch == true }.count
        VStack(spacing: 0) {
            ChatHeader(session: session)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(items) { item in
                            ChatItemView(item: item, sessionWorking: session.status == .working)
                                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.accent.opacity(item.id == highlighted ? 0.18 : 0)))
                        }
                        ForEach(Array(pendingTexts.enumerated()), id: \.offset) { _, text in
                            UserBubble(text: text, images: [], pending: true)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
                .onAppear { if !jump(proxy, items) { proxy.scrollTo("bottom", anchor: .bottom) } }
                .onChange(of: entries.count) { _, _ in
                    // The history of a session picked in the search may arrive after the panel opened.
                    if jump(proxy, items) { return }
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
                }
                .onChange(of: state.jumpTo) { _, _ in _ = jump(proxy, items) }
                // Each message from the notch that shows up in the transcript replaces the oldest "sending…" bubble, even
                // when other entries arrive with it.
                .onChange(of: delivered) { old, new in
                    pendingTexts.removeFirst(min(max(new - old, 0), pendingTexts.count))
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

extension ChatPanel {
    /// Scrolls to the item the search picked, once it is in the conversation. False when there is none to show.
    fileprivate func jump(_ proxy: ScrollViewProxy, _ items: [ChatItem]) -> Bool {
        guard let id = state.jumpTo, items.contains(where: { $0.id == id }) else { return false }
        state.jumpTo = nil
        highlighted = id
        withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(id, anchor: .center) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
            withAnimation { if highlighted == id { highlighted = nil } }
        }
        return true
    }
}

struct ChatHeader: View {
    let session: SessionSummary
    @EnvironmentObject var store: SessionStore
    @EnvironmentObject var settings: AppSettings

    /// Saves the conversation as Markdown or as a standalone HTML page, images included (see ConversationExport).
    private func export(_ format: ConversationExport.Format) {
        let text = ConversationExport.render(
            format, title: session.title ?? session.project, subtitle: "\(session.machine) · \(session.cwd)",
            entries: store.entries[session.id] ?? [])
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.init(filenameExtension: format.fileExtension)].compactMap { $0 }
        panel.nameFieldStringValue = "\(session.project)-\(session.id.prefix(8)).\(format.fileExtension)"
        if panel.runAboveNotch() == .OK, let url = panel.url { try? text.write(to: url, atomically: true, encoding: .utf8) }
    }

    /// Offered while a usage limit stops the session: send `continue` once it resets.
    private func autoContinueToggle(until reset: Date) -> some View {
        let on = store.autoContinue.contains(session.id)
        return Button {
            store.toggleAutoContinue(session.id)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: on ? "checkmark.circle.fill" : "circle").font(.system(size: 9))
                Text("Continue at \(reset.formatted(date: .omitted, time: .shortened))").font(.system(size: 9, weight: .semibold))
            }
            .foregroundStyle(on ? Theme.accent : .secondary)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(on ? Theme.accent.opacity(0.16) : Color.white.opacity(0.06)))
        }
        .buttonStyle(.plain)
        .help(on ? "Claude gets “continue” when the limit resets. Click to cancel." : "Send “continue” when the limit resets")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                StatusDot(status: session.status, limit: session.fiveHourLimit)
                Text(session.project).font(.system(size: 13, weight: .bold))
                Text("· \(store.isOnThisMac(session) ? "This Mac" : session.machine)").font(.system(size: 12)).foregroundStyle(.secondary)
                Spacer()
                if settings.showCosts, let cost = session.costUSD {
                    Text(String(format: "$%.2f", cost)).font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
                        .help("Estimated by Claude Code at list price")
                }
                Text(session.status.label).font(.system(size: 11)).foregroundStyle(Color(nsColor: session.status.color))
                if store.isOnThisMac(session) { LocalFolderActions(session: session) }
                Menu {
                    Button("Markdown…") { export(.markdown) }
                    Button("HTML page…") { export(.html) }
                } label: {
                    Image(systemName: "square.and.arrow.up").font(.system(size: 11))
                }
                .menuStyle(.button)
                .buttonStyle(.plain)
                .menuIndicator(.hidden)
                .fixedSize()
                .foregroundStyle(.secondary)
                .help("Export the conversation, images included")
            }
            HStack {
                Text(session.title ?? session.cwd).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                if settings.showCosts, let tokens = session.tokens {
                    Text("\(TokenCounts.short(tokens.allInput)) in · \(TokenCounts.short(tokens.output)) out")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .fixedSize()
                        .help(
                            "\(tokens.input.formatted()) input, \(tokens.cacheRead.formatted()) read from the cache, "
                                + "\(tokens.cacheWrite.formatted()) written to it, \(tokens.output.formatted()) output")
                }
                if session.canChat, let reset = session.stoppedUntil() { autoContinueToggle(until: reset) }
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
