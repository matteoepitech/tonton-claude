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
    /// The template whose placeholders are being filled in, above the field.
    @State private var filling: PromptTemplate?
    @State private var values: [String: String] = [:]
    @FocusState private var focusedVariable: String?

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
            if let filling { fillBar(filling) }
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
            templatesMenu
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

    private var templatesMenu: some View {
        Menu {
            ForEach(settings.promptTemplates) { template in
                Button(template.name.isEmpty ? template.text : template.name) { use(template) }
            }
            if !settings.promptTemplates.isEmpty { Divider() }
            Button("Edit templates…") { AppDelegate.shared?.showSettings(pane: .general) }
        } label: {
            Image(systemName: "text.badge.plus")
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Insert a prompt template")
    }

    /// One field per placeholder, and a preview of what goes into the message.
    private func fillBar(_ template: PromptTemplate) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(template.name).font(.system(size: 11, weight: .semibold))
                Spacer()
                Button {
                    filling = nil
                } label: {
                    Image(systemName: "xmark").font(.system(size: 9, weight: .bold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Cancel")
            }
            ForEach(template.variables, id: \.self) { name in
                HStack(spacing: 8) {
                    Text(name).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1).frame(width: 90, alignment: .leading)
                    TextField("", text: Binding(get: { values[name] ?? "" }, set: { values[name] = $0 }))
                        .textFieldStyle(.plain)
                        .font(.system(size: 12))
                        .focused($focusedVariable, equals: name)
                        .padding(.horizontal, 8)
                        .frame(height: 24)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.3)))
                        .onSubmit { insertFilled(template) }
                }
            }
            HStack(alignment: .bottom) {
                Text(template.filled(values.filter { !$0.value.isEmpty }))
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
                Spacer(minLength: 8)
                Button("Insert") { insertFilled(template) }.buttonStyle(.plain).font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.accent)
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.06)))
    }

    private func use(_ template: PromptTemplate) {
        guard let first = template.variables.first else { return insert(template.text) }
        values = [:]
        filling = template
        DispatchQueue.main.async { focusedVariable = first }
    }

    private func insertFilled(_ template: PromptTemplate) {
        insert(template.filled(values.filter { !$0.value.isEmpty }))
        filling = nil
    }

    /// Into the message, after what is already typed.
    private func insert(_ prompt: String) {
        let separator = text.isEmpty || text.hasSuffix(" ") || text.hasSuffix("\n") ? "" : " "
        text += separator + prompt
        focused = true
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
