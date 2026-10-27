import Foundation

/// The links the iPhone app opens: tonton://signin#<recovery key> from the QR code on the Mac, tonton://session/<id>
/// from the Live Activity and the notifications.
public enum PhoneLink: Equatable, Sendable {
    case signIn(Account)
    case session(String)

    public init?(url: URL) {
        guard url.scheme == "tonton" else { return nil }
        switch url.host {
        case "signin":
            guard let account = Account(signInLink: url.absoluteString) else { return nil }
            self = .signIn(account)
        case "session":
            let id = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard !id.isEmpty, !id.contains("/") else { return nil }
            self = .session(id)
        default:
            return nil
        }
    }

    /// Sign-in links are only made on the Mac, from `Account.signInLink`.
    public var url: URL? {
        guard case .session(let id) = self else { return nil }
        var components = URLComponents()
        components.scheme = "tonton"
        components.host = "session"
        components.path = "/" + id
        return components.url
    }
}
