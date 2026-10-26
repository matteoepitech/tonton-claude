import AppKit
import SwiftUI
import TontonCore

struct ChatPanel: View {
    let session: SessionSummary
    @EnvironmentObject var store: SessionStore
    @EnvironmentObject var state: NotchState
    @State private var pendingTexts: [String] = []
    @State private var dropTargeted = false
    /// The item a search jumped to, highlighted for a moment.
    @State private var highlighted: String?
    /// When the last entry came in, which makes the thinking waveform jump.
    @State private var lastEntry = Date.distantPast

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
                        if session.status == .working { ThinkingWave(lastEntry: lastEntry) }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
                .onAppear { if !jump(proxy, items) { proxy.scrollTo("bottom", anchor: .bottom) } }
                .onChange(of: entries.count) { _, _ in
                    lastEntry = Date()
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
                PermissionCard(
                    request: req, sessionRule: store.sessionRule(for: req, in: session),
                    allowForSession: { rule in store.allowForSession(req, rule: rule, in: session.id) }
                ) { allow in store.answer(req, allow: allow, in: session.id) }
                .padding(.horizontal, 10)
                .padding(.bottom, 6)
            }
            Composer(session: session) { text, images in
                store.sendPrompt(text, images: images, to: session.id)
                pendingTexts.append(text.isEmpty ? "(\(images.count) attachment\(images.count == 1 ? "" : "s"))" : text)
            }
        }
        // Files dropped anywhere on the conversation join the message being written.
        .onDrop(of: [.fileURL, .image], isTargeted: $dropTargeted) { providers in
            guard session.canChat, let dropFiles = state.dropFiles else { return false }
            dropFiles(providers)
            return true
        }
        .overlay {
            if dropTargeted && session.canChat {
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(Theme.accent, style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
                    .background(RoundedRectangle(cornerRadius: 12).fill(Theme.accent.opacity(0.08)))
                    .overlay(Label("Drop to attach to this session", systemImage: "paperclip").font(.system(size: 13, weight: .semibold)))
                    .padding(6)
                    .allowsHitTesting(false)
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
    @State private var confirming: SessionCommandName?
    @State private var shareNote: String?

    /// Makes a read-only share and copies its key, for a teammate to paste in the web app.
    private func share(for duration: ShareDuration) {
        Task {
            do {
                let link = try await store.share(session, for: duration)
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(link.string, forType: .string)
                shareNote = "Share key copied, valid for \(duration.label)"
                try? await Task.sleep(for: .seconds(5))
                shareNote = nil
            } catch {
                store.lastError = error.localizedDescription
            }
        }
    }

    /// Saves the conversation as Markdown or as a standalone HTML page, images included (see ConversationExport).
    private func export(_ format: ConversationExport.Format) {
        let text = ConversationExport.render(
            format, title: session.title ?? session.project, subtitle: "\(session.machine) · \(session.cwd)",
            entries: store.entries[session.id] ?? [])
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.init(filenameExtension: format.fileExtension)].compactMap { $0 }
        panel.nameFieldStringValue = "\(session.project)-\(session.id.prefix(8)).\(format.fileExtension)"
        guard panel.runAboveNotch() == .OK, let url = panel.url else { return }
        if let failure = SaveFailure.write(Data(text.utf8), to: url) { store.lastError = failure }
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
            .background(Capsule().fill(on ? Theme.accent.opacity(0.16) : Theme.ink.opacity(0.06)))
        }
        .buttonStyle(.plain)
        .help(on ? "Claude gets “continue” when the limit resets. Click to cancel." : "Send “continue” when the limit resets")
    }

    /// Slash commands its agent runs: Claude Code sessions in tmux and OpenCode sessions, while the session waits for you.
    private var commands: some View {
        Menu {
            ForEach(session.menuCommands, id: \.self) { name in
                Button(name.label) {
                    if name.needsConfirmation { confirming = name } else { store.sendCommand(name, to: session.id) }
                }
            }
            if session.commands.contains(.model) {
                Divider()
                // The tick is the family in use; picking it again still switches, to the latest model of that family.
                Menu(SessionCommandName.model.label) {
                    ForEach(ModelFamily.allCases, id: \.self) { family in
                        Toggle(
                            family.label,
                            isOn: Binding(
                                get: { session.modelFamily == family },
                                set: { _ in store.sendCommand(.model, model: family, to: session.id) }))
                    }
                }
            }
        } label: {
            Image(systemName: "terminal").font(.system(size: 11))
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .foregroundStyle(Theme.secondary)
        .disabled(!session.acceptsCommands)
        .help(session.acceptsCommands ? "Run a command in the session" : "Commands wait until the session is done")
    }

    /// Stops the turn, like Escape in the terminal.
    private var interrupt: some View {
        Button {
            store.sendCommand(.interrupt, to: session.id)
        } label: {
            Image(systemName: "stop.circle").font(.system(size: 11))
        }
        .buttonStyle(.plain)
        .foregroundStyle(Theme.secondary)
        .help("Interrupt, like Escape in the terminal (⌘.)")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                StatusDot(status: session.status, limit: session.fiveHourLimit)
                Text(session.project).font(.system(size: 13, weight: .bold))
                Text("·").font(.system(size: 12)).foregroundStyle(Theme.secondary)
                ToolMark(tool: session.codingTool, size: 10)
                if let style = settings.machineStyles[session.machineId] { MachineBadge(style: style, size: 11) }
                Text(store.isOnThisMac(session) ? "This Mac" : session.machine).font(.system(size: 12)).foregroundStyle(Theme.secondary)
                Spacer()
                if settings.showCosts, let cost = session.costUSD {
                    Text(String(format: "$%.2f", cost)).font(.system(size: 10, design: .monospaced)).foregroundStyle(Theme.secondary)
                        .help("Estimated by \(session.codingTool.label) at list price")
                }
                Text(session.status.label).font(.system(size: 11)).foregroundStyle(Color(nsColor: session.status.color))
                if store.isOnThisMac(session) { LocalFolderActions(session: session) }
                if session.accepts(.interrupt) { interrupt }
                if session.canChat && !session.menuCommands.isEmpty { commands }
                Menu {
                    Button("Markdown…") { export(.markdown) }
                    Button("HTML page…") { export(.html) }
                    if store.canShare(session) {
                        Divider()
                        // A teammate reads this session, and only it, in the web app. Nothing they do reaches it.
                        Menu("Share read-only") {
                            ForEach(ShareDuration.allCases) { duration in
                                Button("For \(duration.label)") { share(for: duration) }
                            }
                        }
                    }
                } label: {
                    Image(systemName: "square.and.arrow.up").font(.system(size: 11))
                }
                .menuStyle(.button)
                .buttonStyle(.plain)
                .menuIndicator(.hidden)
                .fixedSize()
                .foregroundStyle(Theme.secondary)
                .help("Export the conversation, images included, or share it read-only")
            }
            HStack {
                Text(session.title ?? session.cwd).font(.system(size: 11)).foregroundStyle(Theme.secondary).lineLimit(1)
                Spacer()
                if let model = session.modelName {
                    Text(model).font(.system(size: 10, design: .monospaced)).foregroundStyle(Theme.secondary).lineLimit(1).fixedSize()
                        .help("The model Claude Code uses in this session")
                }
                if let context = session.context { ContextGauge(context: context) }
                if settings.showCosts, let tokens = session.tokens {
                    Text("\(TokenCounts.short(tokens.allInput)) in · \(TokenCounts.short(tokens.output)) out")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(Theme.secondary)
                        .fixedSize()
                        .help(
                            "\(tokens.input.formatted()) input, \(tokens.cacheRead.formatted()) read from the cache, "
                                + "\(tokens.cacheWrite.formatted()) written to it, \(tokens.output.formatted()) output")
                }
                if session.canChat, let reset = session.stoppedUntil() { autoContinueToggle(until: reset) }
                if let shareNote {
                    Text(shareNote).font(.system(size: 10)).foregroundStyle(Theme.accent).lineLimit(1)
                }
                if let err = store.lastError {
                    Text(err).font(.system(size: 10)).foregroundStyle(.red).lineLimit(1)
                        .onTapGesture { store.lastError = nil }
                }
            }
            if let confirming {
                ClearConfirmation(cancel: { self.confirming = nil }) {
                    self.confirming = nil
                    store.sendCommand(confirming, to: session.id)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Theme.ink.opacity(0.04))
    }
}

/// Asked in place before `/clear`: the notch is a panel above every window, where an alert would not show.
struct ClearConfirmation: View {
    let cancel: () -> Void
    let clear: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Text("Clear the conversation? Claude starts over without what was said so far.")
                .font(.system(size: 11))
                .lineLimit(2)
            Spacer(minLength: 8)
            Button("Cancel", action: cancel)
                .buttonStyle(.plain)
                .font(.system(size: 11, weight: .medium))
                .padding(.horizontal, 10)
                .frame(height: 22)
                .background(Capsule().fill(Theme.ink.opacity(0.1)))
            Button("Clear", action: clear)
                .buttonStyle(.plain)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 10)
                .frame(height: 22)
                .background(Capsule().fill(Theme.danger))
        }
        .padding(.top, 4)
    }
}

/// How full the session's context is, and a warning before Claude Code compacts it on its own.
struct ContextGauge: View {
    let context: ContextUsage

    var body: some View {
        let near = context.isNearCompaction
        let percent = "\(Int((context.fraction * 100).rounded()))%"
        HStack(spacing: 5) {
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.ink.opacity(0.12))
                Capsule().fill(near ? Color(nsColor: .systemOrange) : Theme.ink.opacity(0.5)).frame(width: 32 * context.fraction)
            }
            .frame(width: 32, height: 4)
            Text(near ? "\(percent) · compacts soon" : "\(percent) context")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(near ? Color(nsColor: .systemOrange) : .secondary)
        }
        .fixedSize()
        .help(
            "Context: \(TokenCounts.short(context.usedTokens)) of \(TokenCounts.short(context.windowTokens)) tokens. "
                + "Claude Code compacts it at about \(TokenCounts.short(context.autoCompactAt)).")
    }
}

/// Under the conversation while Claude works: a small waveform that jumps as entries stream in. Still with Reduce Motion.
struct ThinkingWave: View {
    let lastEntry: Date
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var start = Date()

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { context in
            let levels = Waveform.levels(
                time: context.date.timeIntervalSince(start), sinceEntry: context.date.timeIntervalSince(lastEntry), moving: !reduceMotion)
            HStack(alignment: .center, spacing: 2) {
                ForEach(Array(levels.enumerated()), id: \.offset) { _, level in
                    Capsule().fill(Theme.accent.opacity(0.85)).frame(width: 3, height: 3 + 11 * level)
                }
            }
            .frame(height: 14)
        }
        .padding(.leading, 2)
        .padding(.vertical, 2)
        .accessibilityLabel("Claude is working")
    }
}
