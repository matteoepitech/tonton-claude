import Foundation

/// The bars of the thinking waveform: they jump when an entry comes in and settle back while Claude works on.
public enum Waveform {
    public static let bars = 5
    /// How long the jump of an entry takes to fade, in seconds.
    static let decay = 1.6

    /// Heights from 0 to 1, one per bar, `time` seconds after the waveform started and `sinceEntry` seconds after the
    /// last entry. Without motion, a still, even shape.
    public static func levels(time: TimeInterval, sinceEntry: TimeInterval, moving: Bool = true) -> [Double] {
        guard moving else { return (0..<bars).map { [0.35, 0.6, 0.85, 0.6, 0.35][$0 % 5] } }
        let energy = exp(-max(0, sinceEntry) / decay)
        return (0..<bars).map { bar in
            let swing = (sin(time * (4 + Double(bar) * 1.3) + Double(bar) * 1.7) + 1) / 2
            return 0.2 + 0.15 * swing + 0.65 * energy * swing
        }
    }
}
