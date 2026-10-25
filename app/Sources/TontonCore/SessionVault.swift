import CryptoKit
import Foundation

/// Turns the relay's sealed messages into readable models, and seals what the app sends back.
/// Fields that do not decrypt (another key, corrupted data) degrade to placeholders instead of failing.
public struct SessionVault: Sendable {
    private let key: SymmetricKey

    public init(key: SymmetricKey) {
        self.key = key
    }

    public func session(_ wire: WireSession, machines: [MachineInfo]) -> SessionSummary {
        let info = open(wire.info, as: SessionInfo.self)
        let meta = open(wire.meta, as: SessionMeta.self)
        let permissions = wire.pendingPermissions.compactMap { permission -> PermissionRequest? in
            guard let detail = open(permission.blob, as: PermissionDetail.self) else { return nil }
            return PermissionRequest(
                requestId: permission.requestId, toolName: detail.toolName, description: detail.description,
                inputPreview: detail.inputPreview, ts: permission.ts
            )
        }
        return SessionSummary(
            id: wire.id,
            machineId: wire.machineId,
            machine: info?.machine ?? machines.first { $0.id == wire.machineId }?.name ?? "Unknown machine",
            platform: info?.platform,
            cwd: info?.cwd ?? "",
            project: info?.project ?? "Encrypted session",
            title: meta?.title,
            status: wire.status,
            statusText: open(wire.statusDetail, as: StatusDetail.self)?.text,
            agentOnline: wire.agentOnline,
            canChat: wire.canChat,
            pendingPermissions: permissions,
            costUSD: meta?.costUSD,
            startedAt: ISO8601.parse(wire.startedAt) ?? .distantPast,
            lastActivity: ISO8601.parse(wire.lastActivity) ?? .distantPast,
            lastMessage: meta?.lastMessage
        )
    }

    public func entries(_ wire: [WireEntry]) -> [Entry] {
        wire.compactMap { open($0.blob, as: Entry.self) }
    }

    public func machines(_ wire: [WireMachine]) -> [MachineInfo] {
        wire.map {
            let name = open($0.name, as: MachineName.self)
            return MachineInfo(
                id: $0.id,
                name: name?.name ?? "Unknown machine",
                platform: name?.platform,
                createdAt: ISO8601.parse($0.createdAt) ?? .distantPast,
                lastSeen: $0.lastSeen.flatMap(ISO8601.parse),
                online: $0.online
            )
        }
    }

    public func sealPrompt(text: String, images: [OutgoingImage]) throws -> String {
        try E2E.seal(PromptPayload(text: text, images: images), with: key)
    }

    public func sealMachineName(_ name: String) throws -> String {
        try E2E.seal(MachineName(name: name, platform: nil), with: key)
    }

    private func open<T: Decodable>(_ blob: String?, as type: T.Type) -> T? {
        guard let blob else { return nil }
        return try? E2E.open(blob, as: type, with: key)
    }
}
