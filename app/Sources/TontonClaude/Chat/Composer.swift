import AppKit
import SwiftUI
import TontonCore

/// Message field of the open notch: quick replies, image attachments, and a per-session draft that survives closing.
struct Composer: View {
    let session: SessionSummary
    let onSend: (String, [OutgoingImage]) -> Void
    @EnvironmentObject var state: NotchState
    @EnvironmentObject var settings: AppSettings
    @State private var attachments: [Attachment] = []
    @State private var text = ""
    @FocusState private var focused: Bool

    private var readOnlyReason: String {
        if session.machineId == LocalSessions.machineId {
            return "Read only: install the agent on this Mac (Settings › Machines) to reply from the notch."
        }
        return session.agentOnline
            ? "Read only: start claude from a new terminal to message this session." : "Session offline: history only."
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if session.canChat && !settings.quickReplies.isEmpty { quickReplies }
            if !attachments.isEmpty { attachmentStrip }
            field
            if !session.canChat {
                Text(readOnlyReason)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 4)
        .padding(.bottom, 14)
        .onDrop(of: [.fileURL, .image], isTargeted: nil) { providers in
            guard session.canChat else { return false }
            AttachmentReader.fromDrop(providers) { attachments.append($0) }
            return true
        }
        .onAppear {
            text = state.drafts[session.id] ?? ""
            focused = session.canChat
        }
        .onChange(of: text) { _, value in state.drafts[session.id] = value }
    }

    private var quickReplies: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 6) {
                ForEach(settings.quickReplies, id: \.self) { reply in
                    Button {
                        onSend(reply, [])
                    } label: {
                        Text(reply).font(.system(size: 11)).lineLimit(1).padding(.horizontal, 10).frame(height: 24)
                    }
                    .buttonStyle(.plain)
                    .background(Capsule().fill(.white.opacity(0.08)))
                    .overlay(Capsule().stroke(.white.opacity(0.1)))
                    .help("Send “\(reply)”")
                }
            }
        }
        .scrollIndicators(.never)
    }

    private var attachmentStrip: some View {
        HStack(spacing: 6) {
            ForEach(attachments) { attachment in
                Image(nsImage: attachment.thumbnail)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: 44, height: 44)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .overlay(alignment: .topTrailing) {
                        Button {
                            attachments.removeAll { $0.id == attachment.id }
                        } label: {
                            Image(systemName: "xmark.circle.fill").font(.system(size: 12))
                        }
                        .buttonStyle(.plain)
                        .offset(x: 4, y: -4)
                    }
            }
        }
    }

    private var field: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Button {
                attachments += AttachmentReader.pickFiles()
            } label: {
                Image(systemName: "paperclip")
            }
            .buttonStyle(.plain)
            .help("Attach an image")
            Button {
                attachments += AttachmentReader.fromClipboard()
            } label: {
                Image(systemName: "doc.on.clipboard")
            }
            .buttonStyle(.plain)
            .keyboardShortcut("v", modifiers: [.command, .shift])
            .help("Paste an image from the clipboard (⌘⇧V)")
            TextField(session.canChat ? "Message Claude…  (↩ send, ⌥↩ new line)" : "Read only", text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .lineLimit(1...6)
                .focused($focused)
                .onSubmit(send)
            Button(action: send) { Image(systemName: "arrow.up.circle.fill").font(.system(size: 18)) }
                .buttonStyle(.plain)
                .foregroundStyle(canSend ? Theme.accent : .secondary)
                .disabled(!canSend)
        }
        .disabled(!session.canChat)
        .opacity(session.canChat ? 1 : 0.5)
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.08)))
    }

    private var canSend: Bool {
        session.canChat && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty)
    }

    private func send() {
        guard canSend else { return }
        onSend(text.trimmingCharacters(in: .whitespacesAndNewlines), attachments.map(\.outgoing))
        text = ""
        attachments = []
    }
}
