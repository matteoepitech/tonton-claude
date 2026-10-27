import Foundation
import TontonCore

/// tonton://open, tonton://pin, tonton://close, tonton://toggle, tonton://settings/<pane> and tonton://session/<id>, which
/// the widget's rows open.
enum DeepLink: Equatable {
    case open, pin, close, toggle
    case settings(SettingsPane?)
    case session(String)

    init?(url: URL) {
        guard url.scheme == "tonton" else { return nil }
        switch url.host {
        case "open": self = .open
        case "pin": self = .pin
        case "close": self = .close
        case "settings": self = .settings(SettingsPane(rawValue: url.lastPathComponent))
        case "session": self = WidgetSnapshot.sessionId(in: url).map(DeepLink.session) ?? .open
        default: self = .toggle
        }
    }
}
