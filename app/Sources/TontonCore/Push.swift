import Foundation

/// What a relay with an APNs key adds to a permission alert (`PermissionPush` in shared/protocol.ts). The alert's own
/// text says nothing about the session: the iPhone's notification service extension writes the real one from these
/// sealed blobs, and leaves the generic text when they don't open.
public struct PermissionPush: Codable, Equatable, Sendable {
    public let sessionId: String
    public let requestId: String
    /// Sealed `PermissionDetail`, missing when the alert would not have fit.
    public let request: String?
    /// The session's sealed `SessionInfo`, likewise.
    public let info: String?

    /// The category the relay gives permission alerts.
    public static let category = "permission"

    public init(sessionId: String, requestId: String, request: String?, info: String?) {
        (self.sessionId, self.requestId, self.request, self.info) = (sessionId, requestId, request, info)
    }

    /// From the `tonton` key of a notification's user info. Nil when it is not a permission push.
    public init?(userInfo: [AnyHashable: Any]) {
        guard let payload = userInfo["tonton"], JSONSerialization.isValidJSONObject(payload),
            let data = try? JSONSerialization.data(withJSONObject: payload),
            let push = try? JSONDecoder().decode(Self.self, from: data)
        else { return nil }
        self = push
    }
}

/// A permission alert once opened.
public struct PermissionAlert: Equatable, Sendable {
    public let title: String
    public let subtitle: String
    public let body: String
    /// Nil when only the session opened.
    public let request: PermissionRequest?
}

extension SessionVault {
    /// Nil when neither blob opens: another key, or an alert without them.
    public func alert(for push: PermissionPush, at ts: String = "") -> PermissionAlert? {
        let info = open(push.info, as: SessionInfo.self)
        let detail = open(push.request, as: PermissionDetail.self)
        guard info != nil || detail != nil else { return nil }
        let request = detail.map {
            PermissionRequest(
                requestId: push.requestId, toolName: $0.toolName, description: $0.description, inputPreview: $0.inputPreview, ts: ts)
        }
        return PermissionAlert(
            title: info?.project ?? "Permission request", subtitle: info?.machine ?? "",
            body: request.map(Self.alertBody) ?? "Asks for a permission.",
            request: request)
    }

    /// `Allow Bash? Run the tests`, then the start of the command.
    static func alertBody(_ request: PermissionRequest) -> String {
        let question = request.description.isEmpty ? "Allow \(request.toolName)?" : "Allow \(request.toolName)? \(request.description)"
        let preview = request.inputPreview.trimmingCharacters(in: .whitespacesAndNewlines)
        return preview.isEmpty ? question : "\(question)\n\(preview.prefix(300))"
    }
}
