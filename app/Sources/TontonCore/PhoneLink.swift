import Foundation

/// tonton://session/<id>: what the iPhone's Live Activity and notifications open.
public enum PhoneLink: Equatable, Sendable {
    case session(String)

    public init?(url: URL) {
        guard url.scheme == "tonton", url.host == "session" else { return nil }
        let id = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !id.isEmpty, !id.contains("/") else { return nil }
        self = .session(id)
    }

    public var url: URL? {
        guard case .session(let id) = self else { return nil }
        var components = URLComponents()
        components.scheme = "tonton"
        components.host = "session"
        components.path = "/" + id
        return components.url
    }
}
