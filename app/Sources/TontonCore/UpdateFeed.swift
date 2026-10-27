import Foundation

/// The feed a build of the app updates itself from. scripts/build-app.sh writes it into Info.plist with the EdDSA key that
/// signs its updates only when the maintainer's key is configured, so local and forked builds have none and never check.
public struct UpdateFeed: Equatable, Sendable {
    public let url: URL

    /// Nil unless the bundle has an https feed and a well-formed key. Sparkle would refuse to start otherwise, with an
    /// alert the user can do nothing about.
    public init?(info: [String: Any]) {
        guard let feed = info["SUFeedURL"] as? String, let url = URL(string: feed), url.scheme == "https", url.host?.isEmpty == false,
            let key = (info["SUPublicEDKey"] as? String).flatMap({ Data(base64Encoded: $0) }), key.count == 32
        else { return nil }
        self.url = url
    }
}
