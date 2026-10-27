import SwiftUI
import TontonCore

/// One conversation: what Claude said and did, its permission requests, and a field to answer it.
struct SessionView: View {
    let sessionId: String
    @Environment(PhoneStore.self) private var store
    @State private var draft = ""
    @State private var confirmClear = false
    @FocusState private var focused: Bool

    private var session: SessionSummary? { store.feed.session(sessionId) }
    private var items: [ChatItem] { ChatItem.build(from: store.feed.entries[sessionId] ?? []) }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                ForEach(items) { item in ChatItemRow(item: item, working: session?.status == .working) }
                if items.isEmpty {
                    Text(store.connection == .connected ? "Nothing said yet." : "Connecting…")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 40)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) { bottomBar }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) { title }
            if let session, session.terminal {
                ToolbarItem(placement: .topBarTrailing) { commands(session) }
            }
        }
        .confirmationDialog("Clear the conversation?", isPresented: $confirmClear, titleVisibility: .visible) {
            Button("Clear", role: .destructive) { store.run(.clear, in: sessionId) }
        } message: {
            Text("Claude Code starts over in this session, without what was said so far.")
        }
    }

    private var title: some View {
        VStack(spacing: 1) {
            Text(session?.project ?? "Session").font(.headline).lineLimit(1)
            if let session {
                Text("\(session.machine) · \(session.displayStatusText)")
                    .font(.caption)
                    .foregroundStyle(session.status.needsAttention ? session.status.tint : .secondary)
                    .lineLimit(1)
            }
        }
    }

    private func commands(_ session: SessionSummary) -> some View {
        Menu {
            ForEach(SessionCommandName.allCases, id: \.self) { command in
                Button(command.label) {
                    if command.needsConfirmation { confirmClear = true } else { store.run(command, in: sessionId) }
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .disabled(!session.acceptsCommands)
        .accessibilityLabel("Commands")
    }

    private var bottomBar: some View {
        VStack(spacing: 10) {
            if let session {
                ForEach(session.pendingPermissions) { request in
                    PermissionCardView(request: request) { allow in store.answer(request, allow: allow, in: sessionId) }
                }
                if session.canChat {
                    composer
                } else {
                    Text(
                        session.agentOnline
                            ? "Read only: start claude with the launcher on its machine to message it." : "Session offline: history only."
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message", text: $draft, axis: .vertical)
                .lineLimit(1...6)
                .focused($focused)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(RoundedRectangle(cornerRadius: 20).fill(Color(.secondarySystemBackground)))
            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill").font(.system(size: 32))
            }
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("Send")
        }
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        store.send(text, to: sessionId)
        draft = ""
    }
}

/// A permission request: what Claude wants to run, Deny and Allow.
struct PermissionCardView: View {
    let request: PermissionRequest
    let answer: (Bool) -> Void
    @State private var answered: Bool?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Allow \(request.toolName)?", systemImage: "lock.shield.fill")
                .font(.headline)
                .foregroundStyle(.orange)
            if !request.description.isEmpty {
                Text(request.description).font(.subheadline)
            }
            if !request.inputPreview.isEmpty {
                Text(request.inputPreview)
                    .font(.caption.monospaced())
                    .lineLimit(8)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.06)))
            }
            HStack(spacing: 10) {
                Button(role: .destructive) {
                    reply(false)
                } label: {
                    Text("Deny").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                Button {
                    reply(true)
                } label: {
                    Text("Allow").bold().frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(.orange)
            }
            .controlSize(.large)
            .disabled(answered != nil)
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 16).fill(Color.orange.opacity(0.1)))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.orange.opacity(0.35)))
        .sensoryFeedback(.success, trigger: answered) { _, value in value == true }
        .task(id: answered) {
            // The card goes once the relay confirms. If the answer never lands, the buttons come back.
            guard answered != nil else { return }
            try? await Task.sleep(for: .seconds(4))
            answered = nil
        }
    }

    private func reply(_ allow: Bool) {
        answered = allow
        answer(allow)
    }
}
