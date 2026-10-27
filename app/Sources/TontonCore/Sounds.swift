import Foundation

/// What the notch can play a sound for, each with its own choice in Settings › Notch.
public enum SoundEvent: String, CaseIterable, Sendable {
    case finished, permission, question, error

    public static func of(_ status: SessionStatus, finished: Bool) -> SoundEvent {
        if finished { return .finished }
        switch status {
        case .permission: return .permission
        case .error: return .error
        default: return .question
        }
    }
}

/// A project can have a sound of its own when it finishes, to know which one did without looking. Every other event,
/// and a project without one, plays the event's sound.
public enum ProjectSound {
    public static func pick(_ event: SoundEvent, project: String, projectSounds: [String: String], eventSound: String) -> String {
        guard event == .finished, let sound = projectSounds[project], !sound.isEmpty else { return eventSound }
        return sound
    }
}

/// Sound packs: the macOS alert sounds, and chiptunes made on the fly.
public enum SoundPack: String, CaseIterable, Sendable {
    case macOS, eightBit

    public var label: String { self == .macOS ? "macOS" : String(core: "8-bit") }

    /// The sound of each event in this pack.
    public func sound(for event: SoundEvent) -> String {
        switch (self, event) {
        case (.macOS, .finished): "Glass"
        case (.macOS, .permission): "Ping"
        case (.macOS, .question): "Tink"
        case (.macOS, .error): "Basso"
        case (.eightBit, .finished): ChipSound.coin.id
        case (.eightBit, .permission): ChipSound.alert.id
        case (.eightBit, .question): ChipSound.blip.id
        case (.eightBit, .error): ChipSound.error.id
        }
    }
}

/// 8-bit sounds: square waves played note after note, as a WAV the system can play.
public enum ChipSound: String, CaseIterable, Sendable {
    case coin, powerUp, alert, blip, error

    /// How sounds are named in the settings, whatever the language. macOS sounds keep their system name.
    public var id: String { "8-bit \(name)" }

    private var name: String {
        switch self {
        case .coin: "Coin"
        case .powerUp: "Power-up"
        case .alert: "Alert"
        case .blip: "Blip"
        case .error: "Error"
        }
    }

    /// What the menus show.
    public var label: String {
        switch self {
        case .coin: String(core: "8-bit Coin")
        case .powerUp: String(core: "8-bit Power-up")
        case .alert: String(core: "8-bit Alert")
        case .blip: String(core: "8-bit Blip")
        case .error: String(core: "8-bit Error")
        }
    }

    public static func named(_ id: String) -> ChipSound? { allCases.first { $0.id == id } }

    /// Frequencies in hertz (0 for a rest) and lengths in seconds.
    var notes: [(frequency: Double, duration: Double)] {
        switch self {
        case .coin: [(988, 0.07), (1319, 0.24)]
        case .powerUp: [(523, 0.06), (659, 0.06), (784, 0.06), (1047, 0.14)]
        case .alert: [(880, 0.08), (0, 0.04), (880, 0.08), (0, 0.04), (1175, 0.12)]
        case .blip: [(1047, 0.05), (1568, 0.06)]
        case .error: [(392, 0.1), (330, 0.1), (262, 0.22)]
        }
    }

    static let sampleRate = 22_050

    /// An 8-bit mono WAV file.
    public var wav: Data {
        var samples: [UInt8] = []
        for note in notes {
            let count = Int(note.duration * Double(Self.sampleRate))
            for index in 0..<count {
                guard note.frequency > 0 else {
                    samples.append(128)
                    continue
                }
                let phase = Double(index) * note.frequency / Double(Self.sampleRate)
                let square: Double = phase.truncatingRemainder(dividingBy: 1) < 0.5 ? 1 : -1
                // A short fade at both ends of each note keeps it from clicking.
                let fade = min(1, Double(min(index, count - index)) / 120)
                samples.append(UInt8(128 + square * 40 * fade))
            }
        }
        return Self.wavFile(samples)
    }

    static func wavFile(_ samples: [UInt8]) -> Data {
        func little<T: FixedWidthInteger>(_ value: T) -> [UInt8] { withUnsafeBytes(of: value.littleEndian) { Array($0) } }
        let rate = UInt32(sampleRate)
        var data = Array("RIFF".utf8) + little(UInt32(36 + samples.count)) + Array("WAVE".utf8)
        // PCM, mono, 8 bits: one byte per sample.
        data += Array("fmt ".utf8) + little(UInt32(16)) + little(UInt16(1)) + little(UInt16(1)) + little(rate) + little(rate)
        data += little(UInt16(1)) + little(UInt16(8))
        data += Array("data".utf8) + little(UInt32(samples.count)) + samples
        return Data(data)
    }
}
