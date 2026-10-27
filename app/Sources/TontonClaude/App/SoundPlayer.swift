import AppKit
import TontonCore

/// Plays an alert sound by the name the settings keep: a macOS sound, or one of the 8-bit pack made on the fly.
@MainActor
enum SoundPlayer {
    private static var chips: [String: NSSound] = [:]

    /// Every sound the pickers offer.
    static var names: [String] { AppSettings.alertSounds + ChipSound.allCases.map(\.id) }

    /// What a picker shows for one of `names`, which the settings keep whatever the language: macOS sounds by the name
    /// System Settings gives them.
    static func label(_ name: String) -> String {
        if let chip = ChipSound.named(name) { return chip.label }
        switch name {
        case "Glass": return String(localized: "Glass", comment: "A macOS alert sound")
        case "Tink": return String(localized: "Tink", comment: "A macOS alert sound")
        case "Ping": return String(localized: "Ping", comment: "A macOS alert sound")
        case "Pop": return String(localized: "Pop", comment: "A macOS alert sound")
        case "Purr": return String(localized: "Purr", comment: "A macOS alert sound")
        case "Hero": return String(localized: "Hero", comment: "A macOS alert sound")
        case "Submarine": return String(localized: "Submarine", comment: "A macOS alert sound")
        case "Funk": return String(localized: "Funk", comment: "A macOS alert sound")
        case "Bottle": return String(localized: "Bottle", comment: "A macOS alert sound")
        case "Frog": return String(localized: "Frog", comment: "A macOS alert sound")
        case "Basso": return String(localized: "Basso", comment: "A macOS alert sound")
        default: return name
        }
    }

    static func play(_ name: String) {
        guard let chip = ChipSound.named(name) else {
            NSSound(named: name)?.play()
            return
        }
        let sound = chips[name] ?? NSSound(data: chip.wav)
        chips[name] = sound
        sound?.stop()
        sound?.play()
    }
}
