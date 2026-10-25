import Foundation

/// tonton://open, tonton://pin, tonton://close, tonton://toggle and tonton://settings/<pane>.
enum DeepLink: Equatable {
    case open, pin, close, toggle
    case settings(SettingsPane?)

    init?(url: URL) {
        guard url.scheme == "tonton" else { return nil }
        switch url.host {
        case "open": self = .open
        case "pin": self = .pin
        case "close": self = .close
        case "settings": self = .settings(SettingsPane(rawValue: url.lastPathComponent))
        default: self = .toggle
        }
    }
}
