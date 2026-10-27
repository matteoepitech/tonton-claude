import Foundation

/// The size of the text in the open notch (Settings › General). The closed notch, its pills and the banner keep their
/// size: they fit the camera housing.
public enum NotchTextSize: String, CaseIterable, Sendable {
    case small, standard, large

    public var label: String {
        switch self {
        case .small: "Small"
        case .standard: "Default"
        case .large: "Large"
        }
    }

    /// How much bigger than the sizes the views are written with.
    public var scale: Double {
        switch self {
        case .small: 0.9
        case .standard: 1
        case .large: 1.2
        }
    }

    /// A font size of the views at this text size, to the half point.
    public func points(_ size: Double) -> Double { (size * scale * 2).rounded() / 2 }
}
