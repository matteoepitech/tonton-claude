import AppKit
import TontonCore

/// Plays an alert sound by the name the settings keep: a macOS sound, or one of the 8-bit pack made on the fly.
@MainActor
enum SoundPlayer {
    private static var chips: [String: NSSound] = [:]

    /// Every sound the pickers offer.
    static var names: [String] { AppSettings.alertSounds + ChipSound.allCases.map(\.id) }

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
