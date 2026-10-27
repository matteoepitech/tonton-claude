import AppKit
import SwiftUI
import TontonCore
import TontonMac

/// Message field of the open notch: quick replies, image attachments, and a per-session draft that survives closing.
struct Composer: View {
    let session: SessionSummary
    let onSend: (String, [OutgoingImage]) -> Void
    @EnvironmentObject var state: NotchState
    @EnvironmentObject var settings: AppSettings
    @State private var attachments: [Attachment] = []
    /// Why the last file could not be attached.
    @State private var attachError: String?
    @State private var text = ""
    @FocusState private var focused: Bool
    /// The template whose placeholders are being filled in, above the field.
    @State private var filling: PromptTemplate?
    @State private var values: [String: String] = [:]
    @FocusState private var focusedVariable: String?
    @ObservedObject private var queues = MessageQueues.shared
    @StateObject private var dictation = Dictation()
    /// What was typed before dictation started: the transcript goes after it.
    @State private var typedBeforeDictation = ""

    private var readOnlyReason: String {
        if session.tool == "opencode" {
            return session.agentOnline
                ? "Read only: click Update agent for this machine to message its OpenCode sessions." : "Session offline: history only."
        }
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
            if !queues.items(for: session.id).isEmpty { queueList }
            if let problem = dictation.problem {
                Text(problem).font(.notch(10)).foregroundStyle(Theme.warning).fixedSize(horizontal: false, vertical: true)
            }
            if !session.canChat {
                Text(readOnlyReason)
                    .font(.notch(10))
                    .foregroundStyle(Theme.secondary)
            } else if let attachError {
                Text(attachError).font(.notch(10)).foregroundStyle(Theme.danger)
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 4)
        .padding(.bottom, 14)
        .onDrop(of: [.fileURL, .image], isTargeted: nil) { providers in
            guard session.canChat else { return false }
            AttachmentReader.fromDrop(providers) { add($0) }
            return true
        }
        .onAppear {
            state.dropFiles = { providers in AttachmentReader.fromDrop(providers) { add($0) } }
            text = state.drafts[session.id] ?? ""
            attachments = state.draftAttachments[session.id] ?? []
            focused = session.canChat
        }
        .onChange(of: text) { _, value in state.drafts[session.id] = value }
        .onChange(of: attachments.map(\.id)) { _, _ in state.draftAttachments[session.id] = attachments.isEmpty ? nil : attachments }
        .onChange(of: state.pushToTalk) { _, held in held ? startDictation() : dictation.stop() }
        .onChange(of: dictation.transcript) { _, words in text = DictationText.merge(typed: typedBeforeDictation, transcript: words) }
        .onDisappear { dictation.stop() }
    }

    private func startDictation() {
        guard session.canChat else { return }
        typedBeforeDictation = text
        dictation.start()
    }

    private var micButton: some View {
        Button {
            dictation.listening ? dictation.stop() : startDictation()
        } label: {
            Image(systemName: dictation.listening ? "mic.fill" : "mic")
                .foregroundStyle(dictation.listening ? Theme.danger : .primary)
                .symbolEffect(.pulse, isActive: dictation.listening)
        }
        .buttonStyle(.plain)
        .help(dictation.listening ? "Stop dictating" : "Dictate a message (or hold ⌃)")
    }

    private var quickReplies: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 6) {
                ForEach(settings.quickReplies, id: \.self) { reply in
                    Button {
                        onSend(reply, [])
                    } label: {
                        Text(reply).font(.notch(11)).lineLimit(1).padding(.horizontal, 10).frame(height: 24)
                    }
                    .buttonStyle(.plain)
                    .background(Capsule().fill(Theme.ink.opacity(0.08)))
                    .overlay(Capsule().stroke(Theme.line(0.1)))
                    .help("Send “\(reply)”")
                }
            }
        }
        .scrollIndicators(.never)
    }

    /// Images as thumbnails, other files as a chip with their icon, name and size, and what the message carries.
    private var attachmentStrip: some View {
        let total = attachments.reduce(0) { $0 + $1.data.count }
        return VStack(alignment: .leading, spacing: 4) {
            ScrollView(.horizontal) {
                HStack(spacing: 6) {
                    ForEach(attachments) { attachment in
                        Group {
                            if attachment.isImage {
                                Image(nsImage: attachment.thumbnail)
                                    .resizable()
                                    .aspectRatio(contentMode: .fill)
                                    .frame(width: 44, height: 44)
                                    .clipShape(RoundedRectangle(cornerRadius: 6))
                            } else {
                                fileChip(attachment)
                            }
                        }
                        .quickLook({ preview(attachment) }, state: state)
                        .overlay(alignment: .topTrailing) {
                            Button {
                                attachments.removeAll { $0.id == attachment.id }
                                attachError = nil
                            } label: {
                                Image(systemName: "xmark.circle.fill").font(.notch(12))
                            }
                            .buttonStyle(.plain)
                            .offset(x: 4, y: -4)
                        }
                    }
                }
                .padding(.top, 5)
                .padding(.trailing, 5)
            }
            .scrollIndicators(.never)
            Text(
                "\(attachments.count) attachment\(attachments.count == 1 ? "" : "s") · \(AttachmentBudget.describe(total)) of \(AttachmentBudget.describe(AttachmentBudget.maxTotalBytes))"
            )
            .font(.notch(9))
            .foregroundStyle(Theme.tertiary)
        }
    }

    /// The attachments of the message, opened on this one.
    private func preview(_ attachment: Attachment) {
        let index = attachments.firstIndex { $0.id == attachment.id } ?? 0
        attachError = QuickLook.shared.show(attachments.map { QuickLook.Item(name: $0.name, data: $0.data) }, at: index)
    }

    private func fileChip(_ attachment: Attachment) -> some View {
        HStack(spacing: 6) {
            Image(nsImage: attachment.thumbnail).resizable().frame(width: 26, height: 26)
            VStack(alignment: .leading, spacing: 1) {
                Text(attachment.name).font(.notch(11, weight: .medium)).lineLimit(1).truncationMode(.middle)
                Text(AttachmentBudget.describe(attachment.data.count)).font(.notch(9)).foregroundStyle(Theme.secondary)
            }
        }
        .padding(.horizontal, 8)
        .frame(width: 150, height: 44, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(Theme.ink.opacity(0.08)))
    }

    /// Joins the message if it fits what one message can carry; otherwise says why.
    private func add(_ loaded: AttachmentReader.Loaded) {
        switch loaded {
        case .refused(let reason):
            attachError = reason
        case .attachment(let attachment):
            if let problem = AttachmentBudget.problem(
                adding: attachment.name, bytes: attachment.data.count, to: attachments.map(\.data.count))
            {
                attachError = problem
            } else {
                attachments.append(attachment)
                attachError = nil
            }
        }
    }

    private var field: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Button {
                AttachmentReader.pickFiles().forEach(add)
            } label: {
                Image(systemName: "paperclip")
            }
            .buttonStyle(.plain)
            .help("Attach files, up to \(AttachmentBudget.describe(AttachmentBudget.maxTotalBytes)) per message")
            Button {
                AttachmentReader.fromClipboard().forEach(add)
            } label: {
                Image(systemName: "doc.on.clipboard")
            }
            .buttonStyle(.plain)
            .keyboardShortcut("v", modifiers: [.command, .shift])
            .help("Paste an image from the clipboard (⌘⇧V)")
            templatesMenu
            micButton
            TextField(placeholder, text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.notch(12))
                .lineLimit(1...6)
                .focused($focused)
                .onSubmit(send)
            Button(action: enqueue) { Image(systemName: "text.line.last.and.arrowtriangle.forward").font(.notch(13)) }
                .buttonStyle(.plain)
                .foregroundStyle(canSend ? AnyShapeStyle(.primary) : Theme.secondary)
                .disabled(!canSend)
                .keyboardShortcut(.return, modifiers: [.command, .shift])
                .help("Send after Claude's current turn (⌘⇧↩)")
            Button(action: send) { Image(systemName: "arrow.up.circle.fill").font(.notch(18)) }
                .buttonStyle(.plain)
                .foregroundStyle(canSend ? Theme.accent : .secondary)
                .disabled(!canSend)
        }
        .disabled(!session.canChat)
        .opacity(session.canChat ? 1 : 0.5)
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.ink.opacity(0.08)))
    }

    private var placeholder: String {
        if !session.canChat { return "Read only" }
        return dictation.listening ? "Listening…" : "Message Claude…  (↩ send, ⌥↩ new line)"
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
                Text(template.name).font(.notch(11, weight: .semibold))
                Spacer()
                Button {
                    filling = nil
                } label: {
                    Image(systemName: "xmark").font(.notch(9, weight: .bold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.secondary)
                .help("Cancel")
            }
            ForEach(template.variables, id: \.self) { name in
                HStack(spacing: 8) {
                    Text(name).font(.notch(11)).foregroundStyle(Theme.secondary).lineLimit(1).frame(width: 90, alignment: .leading)
                    TextField("", text: Binding(get: { values[name] ?? "" }, set: { values[name] = $0 }))
                        .textFieldStyle(.plain)
                        .font(.notch(12))
                        .focused($focusedVariable, equals: name)
                        .padding(.horizontal, 8)
                        .frame(height: 24)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Theme.code))
                        .onSubmit { insertFilled(template) }
                }
            }
            HStack(alignment: .bottom) {
                Text(template.filled(values.filter { !$0.value.isEmpty }))
                    .font(.notch(10))
                    .foregroundStyle(Theme.tertiary)
                    .lineLimit(2)
                Spacer(minLength: 8)
                Button("Insert") { insertFilled(template) }.buttonStyle(.plain).font(.notch(11, weight: .semibold))
                    .foregroundStyle(Theme.accent)
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.ink.opacity(0.06)))
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

    /// Waits for Claude to finish the turn in progress, and for the messages queued before it.
    private func enqueue() {
        guard canSend else { return }
        queues.add(
            QueuedMessage(text: text.trimmingCharacters(in: .whitespacesAndNewlines), images: attachments.map(\.outgoing)), to: session.id)
        text = ""
        attachments = []
    }

    /// The queued messages, in the order they will go, each one movable and cancellable.
    private var queueList: some View {
        let items = queues.items(for: session.id)
        return VStack(alignment: .leading, spacing: 4) {
            Text("QUEUED · sent one per turn").font(.notch(9, weight: .semibold)).foregroundStyle(Theme.tertiary)
            ForEach(Array(items.enumerated()), id: \.element.id) { index, message in
                HStack(spacing: 6) {
                    Text("\(index + 1)").font(.notch(10, weight: .semibold, design: .rounded)).foregroundStyle(Theme.secondary)
                        .frame(
                            width: 12)
                    Text(message.text.isEmpty ? "\(message.images.count) image(s)" : message.text)
                        .font(.notch(11)).lineLimit(1).truncationMode(.tail)
                    Spacer(minLength: 4)
                    queueButton("chevron.up", "Earlier", disabled: index == 0) { queues.move(message.id, by: -1, in: session.id) }
                    queueButton("chevron.down", "Later", disabled: index == items.count - 1) {
                        queues.move(message.id, by: 1, in: session.id)
                    }
                    queueButton("xmark", "Cancel", disabled: false) { queues.remove(message.id, from: session.id) }
                }
                .padding(.horizontal, 8)
                .frame(height: 24)
                .background(RoundedRectangle(cornerRadius: 6).fill(Theme.ink.opacity(0.05)))
            }
        }
    }

    private func queueButton(_ symbol: String, _ help: String, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol).font(.notch(9, weight: .bold)) }
            .buttonStyle(.plain)
            .foregroundStyle(disabled ? Theme.tertiary : Theme.secondary)
            .disabled(disabled)
            .help(help)
    }

    private func send() {
        guard canSend else { return }
        onSend(text.trimmingCharacters(in: .whitespacesAndNewlines), attachments.map(\.outgoing))
        text = ""
        attachments = []
    }
}
