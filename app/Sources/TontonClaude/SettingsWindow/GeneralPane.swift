import AppKit
import SwiftUI
import TontonCore

struct GeneralPane: View {
    @EnvironmentObject var settings: AppSettings
    @State private var newReply = ""

    private var shortcuts: [(String, [String])] {
        [
            ("Toggle the notch", settings.hotkey.keys), ("Close the notch", ["esc"]), ("Jump to session 1…9, pinned first", ["⌘", "1…9"]),
            ("Previous / next session", ["⌘", "↑↓"]), ("Send a message", ["↩"]), ("New line", ["⌥", "↩"]),
            ("Allow the pending request", ["⌘", "↩"]), ("Paste an image", ["⌘", "⇧", "V"]),
        ].filter { !$0.1.isEmpty }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Card {
                ToggleRow(title: "Launch at login", detail: "Start Tonton Claude when you log in.", isOn: $settings.launchAtLogin)
                Hairline()
                ToggleRow(
                    title: "Menu bar icon", detail: "Without it, open Tonton Claude from Spotlight to get back here.",
                    isOn: $settings.showMenuBarIcon)
                Hairline()
                Row(title: "Global shortcut", detail: "Opens and closes the notch from anywhere.") {
                    ChoiceMenu(selection: settings.hotkey.rawValue, options: HotKeyPreset.allCases.map { ($0.rawValue, $0.label) }) {
                        settings.hotkey = HotKeyPreset(rawValue: $0) ?? .optionCommandN
                    }
                }
            }
            GroupLabel(text: "Display")
            Card {
                Row(title: "Show on", detail: "Built-in display uses the real notch; main display follows your primary screen.") {
                    ChoiceMenu(selection: settings.display.rawValue, options: DisplayChoice.allCases.map { ($0.rawValue, $0.label) }) {
                        settings.display = DisplayChoice(rawValue: $0) ?? .builtIn
                    }
                }
                Hairline()
                Row(title: "Notch size", detail: "Size of the open notch.") {
                    Segmented(selection: settings.notchSize.rawValue, options: NotchSizeChoice.allCases.map { ($0.rawValue, $0.label) }) {
                        settings.notchSize = NotchSizeChoice(rawValue: $0) ?? .standard
                    }
                }
            }
            GroupLabel(text: "Sessions")
            Card {
                ToggleRow(
                    title: "Show costs", detail: "Cost and tokens per session, and today's total in the notch bar.",
                    isOn: $settings.showCosts)
                Hairline()
                Row(title: "Hide finished sessions", detail: "Closed and offline sessions leave the list after a while.") {
                    ChoiceMenu(
                        selection: String(settings.hideFinishedAfterHours),
                        options: [("0", "Never"), ("1", "After 1 hour"), ("6", "After 6 hours"), ("24", "After 1 day")]
                    ) {
                        settings.hideFinishedAfterHours = Int($0) ?? 0
                    }
                }
                Hairline()
                Row(title: "Open files in", detail: "Files Claude reads or edits on this Mac open from the conversation.") {
                    ChoiceMenu(
                        selection: settings.editor.available.rawValue, options: EditorChoice.installed.map { ($0.rawValue, $0.label) }
                    ) {
                        settings.editor = EditorChoice(rawValue: $0) ?? .defaultApp
                    }
                }
                Hairline()
                Row(title: "Terminal", detail: "Sessions on this Mac open their folder in it.") {
                    ChoiceMenu(
                        selection: settings.terminal.available.rawValue,
                        options: TerminalChoice.installed.map { ($0.rawValue, $0.label) }
                    ) {
                        settings.terminal = TerminalChoice(rawValue: $0) ?? .terminal
                    }
                }
            }
            GroupLabel(text: "Quick replies")
            Card {
                VStack(alignment: .leading, spacing: 10) {
                    Text("One click sends them to the session, from the chips above the message field.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textDim)
                    FlowChips(items: settings.quickReplies) { reply in settings.quickReplies.removeAll { $0 == reply } }
                    HStack(spacing: 6) {
                        ThemeField(placeholder: "Add a quick reply", text: $newReply)
                            .onSubmit(add)
                        Button("Add", action: add).buttonStyle(ThemeButtonStyle()).disabled(
                            newReply.trimmingCharacters(in: .whitespaces).isEmpty)
                        Button("Reset") { settings.quickReplies = AppSettings.defaultQuickReplies }.buttonStyle(ThemeButtonStyle())
                    }
                }
                .padding(16)
            }
            GroupLabel(text: "Prompt templates")
            Card {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Insert them from the message field. A {name} becomes a field to fill in, e.g. Review PR #{number}.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textDim)
                    ForEach(settings.promptTemplates) { template in
                        HStack(spacing: 6) {
                            ThemeField(placeholder: "Name", text: templateBinding(template.id, \.name)).frame(width: 150)
                            ThemeField(placeholder: "Prompt, with {placeholders}", text: templateBinding(template.id, \.text))
                            Button {
                                settings.promptTemplates.removeAll { $0.id == template.id }
                            } label: {
                                Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).frame(height: 18)
                            }
                            .buttonStyle(ThemeButtonStyle())
                            .help("Delete this template")
                        }
                    }
                    HStack(spacing: 6) {
                        Button("Add") { settings.promptTemplates.append(PromptTemplate(name: "", text: "")) }.buttonStyle(
                            ThemeButtonStyle())
                        Button("Reset") { settings.promptTemplates = AppSettings.defaultTemplates }.buttonStyle(ThemeButtonStyle())
                    }
                }
                .padding(16)
            }
            GroupLabel(text: "Keyboard shortcuts")
            Card {
                ForEach(Array(shortcuts.enumerated()), id: \.offset) { index, item in
                    if index > 0 { Hairline() }
                    HStack {
                        Text(item.0).font(.system(size: 13))
                        Spacer()
                        HStack(spacing: 3) { ForEach(item.1, id: \.self) { Keycap(key: $0) } }
                    }
                    .padding(.horizontal, 16)
                    .frame(height: 42)
                }
            }
            HStack {
                Text("Tonton Claude \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev")")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textFaint)
                Spacer()
                Button("Quit Tonton Claude") { NSApp.terminate(nil) }.buttonStyle(ThemeButtonStyle())
            }
            .padding(.top, 28)
        }
    }

    /// By id, so deleting a template while a field is being edited never reads a stale index.
    private func templateBinding(_ id: UUID, _ field: WritableKeyPath<PromptTemplate, String>) -> Binding<String> {
        Binding(
            get: { settings.promptTemplates.first { $0.id == id }?[keyPath: field] ?? "" },
            set: { value in
                if let index = settings.promptTemplates.firstIndex(where: { $0.id == id }) {
                    settings.promptTemplates[index][keyPath: field] = value
                }
            })
    }

    private func add() {
        let reply = newReply.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !reply.isEmpty, !settings.quickReplies.contains(reply) else { return }
        settings.quickReplies.append(reply)
        newReply = ""
    }
}
