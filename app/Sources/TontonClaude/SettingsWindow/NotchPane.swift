import AppKit
import SwiftUI
import TontonCore

struct NotchPane: View {
    @EnvironmentObject var settings: AppSettings

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            GroupLabel(text: "Behavior").padding(.top, -26)
            Card {
                ToggleRow(
                    title: "Open on hover", detail: "Otherwise use the keyboard shortcut or a tonton://open link.",
                    isOn: $settings.openOnHover)
                Hairline()
                ToggleRow(
                    title: "Activity dots", detail: "Show the most urgent status and the live count beside the camera.",
                    isOn: $settings.showActivityDots)
                Hairline()
                ToggleRow(
                    title: "Tonton", detail: "A small character beside the camera: types while Claude works, sleeps when it's done.",
                    isOn: $settings.showMascot)
                Hairline()
                ToggleRow(
                    title: "Live activity", detail: "Widen the notch to show what a working session is doing, like the Dynamic Island.",
                    isOn: $settings.liveActivity)
                Hairline()
                ToggleRow(
                    title: "Glow while working", detail: "A light runs around the notch while a session works, in its status color.",
                    isOn: $settings.workingGlow)
                Hairline()
                ToggleRow(
                    title: "Open on approval requests", detail: "Expand the notch straight on the session asking for permission.",
                    isOn: $settings.openOnPermission)
            }
            GroupLabel(text: "Look")
            Card {
                Row(
                    title: "Transparency",
                    detail: "How much of the desktop shows through the open notch. Text stays readable at every value."
                ) {
                    HStack(spacing: 8) {
                        Text("Opaque").font(.system(size: 11)).foregroundStyle(Theme.textDim)
                        Slider(value: $settings.notchTransparency, in: 0...1).tint(Theme.accent).frame(width: 150)
                        Text("Clear").font(.system(size: 11)).foregroundStyle(Theme.textDim)
                    }
                }
            }
            GroupLabel(text: "Alerts")
            Card {
                ToggleRow(
                    title: "Heads-up banner", detail: "Slides out under the camera when a session needs you.", isOn: $settings.showAlerts)
                Hairline()
                ToggleRow(
                    title: "Tell me when Claude finishes", detail: "Also alert when a session goes from working to done.",
                    isOn: $settings.alertOnFinish)
                Hairline()
                Row(title: "Confetti after long tasks", detail: "Celebrate a session that finishes after working this long.") {
                    ChoiceMenu(
                        selection: String(settings.confettiAfterMinutes),
                        options: [("0", "Never")] + [5, 10, 20, 30, 60].map { (String($0), "\($0) minutes") }
                    ) {
                        settings.confettiAfterMinutes = Int($0) ?? 0
                    }
                }
                Hairline()
                ToggleRow(
                    title: "Tell me when a limit resets",
                    detail: "Also alert when a session stopped by a usage limit can go again.", isOn: $settings.alertOnLimitReset)
                Hairline()
                ToggleRow(title: "Sound", detail: "Plays with the banner.", isOn: $settings.soundOnAttention)
                if settings.soundOnAttention {
                    Hairline()
                    Row(title: "Sound pack", detail: "Sets the sound of every event below.") {
                        ChoiceMenu(selection: currentPack, options: SoundPack.allCases.map { ($0.rawValue, $0.label) } + mixed) { id in
                            guard let pack = SoundPack(rawValue: id) else { return }
                            for event in SoundEvent.allCases { settings.eventSounds[event.rawValue] = pack.sound(for: event) }
                            SoundPlayer.play(pack.sound(for: .finished))
                        }
                    }
                    ForEach(SoundEvent.allCases, id: \.self) { event in
                        Hairline()
                        Row(title: Self.title(event)) {
                            ChoiceMenu(selection: settings.sound(for: event), options: SoundPlayer.names.map { ($0, $0) }) { name in
                                settings.eventSounds[event.rawValue] = name
                                SoundPlayer.play(name)
                            }
                        }
                    }
                }
                Hairline()
                ToggleRow(title: "Haptic feedback", detail: "A light tap on the trackpad.", isOn: $settings.haptics)
                Hairline()
                ToggleRow(
                    title: "macOS notifications", detail: "Also show a system notification. Clicking it opens the session.",
                    isOn: $settings.systemNotifications)
            }
            GroupLabel(text: "Quiet hours")
            Card {
                ToggleRow(
                    title: "Mute alerts at night", detail: "No sound, banner or notification during these hours.",
                    isOn: $settings.quietHours)
                if settings.quietHours {
                    Hairline()
                    Row(title: "From") { TimeField(minutes: $settings.quietStart) }
                    Hairline()
                    Row(title: "To") { TimeField(minutes: $settings.quietEnd) }
                }
            }
            GroupLabel(text: "Webhooks")
            Card {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Post to Discord, Slack or any service that takes a JSON webhook, over https only.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textDim)
                    WebhookField(title: "When a session finishes", address: $settings.webhookFinished)
                    WebhookField(title: "When a session needs you", address: $settings.webhookNeedsYou)
                }
                .padding(16)
                Hairline()
                ToggleRow(
                    title: "Include project and machine names", detail: "Otherwise the message only says what happened.",
                    isOn: $settings.webhookIncludeNames)
                Hairline()
                ToggleRow(
                    title: "Include Claude's last message", detail: "Off by default: it can quote your code.",
                    isOn: $settings.webhookIncludeLastMessage)
            }
        }
    }

    /// The pack every event's sound comes from, or none when they were picked one by one.
    private var currentPack: String {
        SoundPack.allCases.first { pack in SoundEvent.allCases.allSatisfy { settings.sound(for: $0) == pack.sound(for: $0) } }?
            .rawValue ?? "custom"
    }

    private var mixed: [(id: String, label: String)] { currentPack == "custom" ? [("custom", "Custom")] : [] }

    private static func title(_ event: SoundEvent) -> String {
        switch event {
        case .finished: "When Claude is done"
        case .permission: "Approval requests"
        case .question: "Questions"
        case .error: "Errors"
        }
    }
}

/// One webhook address, with a button that posts a test message to it.
private struct WebhookField: View {
    let title: String
    @Binding var address: String
    @State private var result: Bool?
    @State private var sending = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 13, weight: .medium))
            HStack(spacing: 6) {
                ThemeField(placeholder: "https://discord.com/api/webhooks/…", text: $address)
                Button(sending ? "Sending…" : "Test") { test() }
                    .buttonStyle(ThemeButtonStyle())
                    .disabled(sending || Webhook.url(address) == nil)
            }
            if !address.isEmpty && Webhook.url(address) == nil {
                Text("Use an https address.").font(.system(size: 11)).foregroundStyle(Theme.danger)
            } else if let result {
                Text(result ? "Sent." : "The service refused it. Check the address.")
                    .font(.system(size: 11))
                    .foregroundStyle(result ? Theme.success : Theme.danger)
            }
        }
        .onChange(of: address) { _, _ in result = nil }
    }

    private func test() {
        guard let url = Webhook.url(address) else { return }
        sending = true
        Task {
            result = await WebhookNotifier.send("Tonton Claude will post here.", to: url)
            sending = false
        }
    }

}
