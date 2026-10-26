import AppKit
import SwiftUI

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
                ToggleRow(
                    title: "Tell me when a limit resets",
                    detail: "Also alert when a session stopped by a usage limit can go again.", isOn: $settings.alertOnLimitReset)
                Hairline()
                ToggleRow(title: "Sound", detail: "Plays with the banner.", isOn: $settings.soundOnAttention)
                if settings.soundOnAttention {
                    Hairline()
                    Row(title: "Alert sound") {
                        ChoiceMenu(selection: settings.alertSound, options: AppSettings.alertSounds.map { ($0, $0) }) { name in
                            settings.alertSound = name
                            NSSound(named: name)?.play()
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
        }
    }
}
