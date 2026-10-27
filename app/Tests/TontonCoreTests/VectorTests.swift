import CryptoKit
import XCTest

@testable import TontonCore

/// Blobs, a token and relay messages made by this implementation, with what it reads from them. The TypeScript client core
/// must read them the same way: shared/test/swift-vectors.test.ts runs on the same file. It is checked here on every run;
/// `TONTON_WRITE_VECTORS=1 swift test --filter VectorTests` writes it again, with a new key and new nonces.
final class VectorTests: XCTestCase {
    private static let file = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("shared/test/swift-vectors.json")

    func testTheVectorsAreWhatThisImplementationMakesAndReads() throws {
        if ProcessInfo.processInfo.environment["TONTON_WRITE_VECTORS"] == "1" {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            try encoder.encode(try Self.make()).write(to: Self.file)
        }
        let vectors = try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: Self.file))
        let key = try E2E.key(fromBase64URL: vectors.key)
        for blob in vectors.blobs {
            XCTAssertEqual(try Self.object(E2E.plaintext(blob.blob, with: key)), try Self.object(Data(blob.plaintext.utf8)), blob.name)
        }
        let token = vectors.accountToken
        let account = Account(relay: token.relay, accountId: token.account, token: "ta_unused", key: token.key, joinSecret: token.secret)
        let payload = { (text: String) in Data(base64URLEncoded: String(text.dropFirst("tonton_".count))) ?? Data() }
        XCTAssertEqual(try Self.object(payload(try XCTUnwrap(account.machineToken))), try Self.object(payload(token.token)))
        XCTAssertEqual(try Self.read(snapshot: vectors.snapshot, history: vectors.history, key: key), vectors.expected)
        let share = vectors.shareLink
        XCTAssertEqual(ShareLink(string: share.text), ShareLink(relay: share.relay, token: share.token, key: share.key))
    }

    // MARK: Writing

    private static func make() throws -> Vectors {
        let keyText = E2E.newKey()
        let key = try E2E.key(fromBase64URL: keyText)
        let other = try E2E.key(fromBase64URL: E2E.newKey())
        let vault = SessionVault(key: key)
        func sealed<T: Encodable>(_ value: T) throws -> String { try E2E.seal(value, with: key) }

        let health = MachineHealth(
            cpu: 0.23, memoryUsed: 12_025_908_428, memoryTotal: 17_179_869_184, battery: nil,
            wake: [WakeOnLAN.Target(mac: "a4:83:e7:12:34:56", broadcast: "192.168.1.255")], at: "2026-10-25T10:04:00.000Z")
        let meta = SessionMeta(
            title: "Rate limit login ✅", costUSD: 0.84, lastMessage: "Deploying",
            fiveHourLimit: WireUsageLimit(usedPercent: 83.5, resetsAt: "2026-10-25T12:00:00.000Z"),
            tokens: TokenCounts(input: 1200, output: 340, cacheRead: 250_000, cacheWrite: 9000),
            context: WireContext(usedTokens: 250_000, windowTokens: nil), terminal: true, commands: ["compact", "model", "future"],
            model: "us.anthropic.claude-opus-4-5-20251101-v1:0", branch: "feat/rate-limit")
        let machines: [[String: Any]] = [
            [
                "id": "m1", "name": try sealed(MachineName(name: "PC-Studio", platform: "win32")), "createdAt": "2026-10-25T10:00:00.000Z",
                "lastSeen": "2026-10-25T10:05:00Z", "online": true, "agentVersion": "0.9.1", "health": try sealed(health),
            ],
            [
                "id": "m2", "name": try E2E.seal(MachineName(name: "Hidden", platform: nil), with: other),
                "createdAt": "2026-10-24T08:00:00.000Z", "lastSeen": NSNull(), "online": false, "agentVersion": NSNull(),
            ],
        ]
        let permission = PermissionDetail(toolName: "Bash", description: "Deploy to staging", inputPreview: "{\"command\":\"make deploy\"}")
        let sessions: [[String: Any]] = [
            [
                "id": "s1", "machineId": "m1", "status": "permission", "agentOnline": true, "canChat": true,
                "info": try sealed(SessionInfo(machine: "PC-Studio", platform: "win32", cwd: "C:\\code\\api", project: "api")),
                "meta": try sealed(meta), "statusDetail": try sealed(StatusDetail(text: "Claude needs your permission to use Bash")),
                "pendingPermissions": [
                    ["requestId": "abcde", "ts": "2026-10-25T10:05:00.000Z", "blob": try sealed(permission)],
                    ["requestId": "fghij", "ts": "2026-10-25T10:05:01.000Z", "blob": try E2E.seal(permission, with: other)],
                ],
                "startedAt": "2026-10-25T10:00:00.123Z", "lastActivity": "2026-10-25T10:05:00Z",
                "name": try vault.sealSessionName("Billing rewrite ✨", for: "s1"),
            ],
            [
                "id": "s2", "machineId": "m1", "status": "idle", "agentOnline": false, "canChat": false,
                "info": try E2E.seal(SessionInfo(machine: "PC-Studio", platform: nil, cwd: "/srv", project: "srv"), with: other),
                "meta": try sealed(["title": "Wrong types", "costUSD": "a lot"]), "statusDetail": NSNull(), "pendingPermissions": [],
                "startedAt": "2026-10-25T09:00:00.000Z", "lastActivity": "yesterday",
                // A name the relay moved from another session: both sides ignore it.
                "name": try vault.sealSessionName("Moved", for: "s1"),
            ],
        ]
        let entries = [
            Entry(id: "u1", ts: "2026-10-25T10:00:01.000Z", kind: .user, text: "Déploie en staging", viaNotch: true),
            Entry(id: "a1", ts: "2026-10-25T10:00:02.000Z", kind: .assistant, text: "Déployé ✅"),
            Entry(
                id: "t1", ts: "2026-10-25T10:00:03.000Z", kind: .tool, toolUseId: "call-1", name: "Edit", summary: "/srv/app.ts",
                edits: [FileEdit(oldText: "let a = 1", newText: "let a = 2")]),
            Entry(id: "r1", ts: "2026-10-25T10:00:04.000Z", kind: .toolResult, text: "ok", toolUseId: "call-1", isError: false),
            Entry(id: "t2", ts: "2026-10-25T10:00:05.000Z", kind: .tool, toolUseId: "call-2", name: "Bash", summary: "make deploy"),
            Entry(id: "y1", ts: "2026-10-25T10:00:06.000Z", kind: .system, text: "Compacted"),
        ]
        var history: [[String: Any]] = try entries.map { ["id": $0.id, "ts": $0.ts, "blob": try sealed($0)] }
        history.insert(
            ["id": "f1", "ts": "2026-10-25T10:00:05.500Z", "blob": try sealed(["id": "f1", "ts": "x", "kind": "future"])], at: 3)
        history.append(["id": "o1", "ts": "2026-10-25T10:00:07.000Z", "blob": try E2E.seal(entries[1], with: other)])

        let issuedAt = Date(timeIntervalSince1970: 1_792_497_600)
        let blobs = [
            (
                "prompt",
                try vault.sealPrompt(
                    text: "Run the tests", images: [OutgoingImage(name: "a.png", mediaType: "image/png", data: "iVBORw0K")])
            ),
            ("command", try vault.sealCommand(.compact, for: "s1", issuedAt: issuedAt)),
            ("model command", try vault.sealCommand(.model, model: .haiku, for: "s1", issuedAt: issuedAt)),
            ("update order", try vault.sealUpdateOrder(version: "0.9.2", issuedAt: issuedAt)),
            ("start order", try vault.sealStartOrder(launchId: "abcdefgh12", machineId: "m1", cwd: "~/code/api", issuedAt: issuedAt)),
            (
                "start answer",
                try vault.sealStartAnswer(launchId: "abcdefgh12", machineId: "m1", question: "q1", confirm: true, issuedAt: issuedAt)
            ),
            ("rules", try vault.sealRules([PermissionRule(tool: "Bash", pattern: "npm test")], issuedAt: issuedAt)),
            ("log request", try vault.sealLogRequest(requestId: "abcdefgh12", machineId: "m1", issuedAt: issuedAt)),
            ("session name", try vault.sealSessionName("Billing rewrite ✨", for: "s1", issuedAt: issuedAt)),
            ("diagnose request", try vault.sealDiagnoseRequest(requestId: "abcdefgh12", machineId: "m1", fix: "hooks", issuedAt: issuedAt)),
            ("machine name", try vault.sealMachineName("Studio ✨")),
            (
                "share order",
                try vault.sealShareOrder(
                    shareId: "abcdefghijkl", sessionId: "s1", shareKey: String(repeating: "k", count: 43),
                    expiresAt: "2026-10-26T10:00:00.000Z")
            ),
        ]
        let share = ShareLink(
            relay: "https://relay.example.com/tonton", token: "ts_abcdefghijkl_" + String(repeating: "t", count: 43),
            key: String(repeating: "k", count: 43))
        let account = Account(
            relay: "https://relay.example.com/tonton", accountId: "abcdefghijkl", token: "ta_unused", key: keyText,
            joinSecret: String(repeating: "s", count: 43))
        let snapshot = try text(["t": "snapshot", "machines": machines, "sessions": sessions])
        let historyText = try text(["t": "history", "sessionId": "s1", "entries": history])
        return Vectors(
            about: "Made by app/Tests/TontonCoreTests/VectorTests.swift, read by shared/test/swift-vectors.test.ts.", key: keyText,
            blobs: try blobs.map { name, blob in Vectors.Blob(name: name, blob: blob, plaintext: try plaintext(blob, key)) },
            accountToken: Vectors.Token(
                token: try XCTUnwrap(account.machineToken), relay: account.relay, account: account.accountId,
                secret: try XCTUnwrap(account.joinSecret), key: keyText),
            snapshot: snapshot, history: historyText, expected: try read(snapshot: snapshot, history: historyText, key: key),
            shareLink: Vectors.Share(text: share.string, relay: share.relay, token: share.token, key: share.key))
    }

    private static func text(_ object: [String: Any]) throws -> String {
        String(
            decoding: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]), as: UTF8.self)
    }

    private static func plaintext(_ blob: String, _ key: SymmetricKey) throws -> String {
        String(decoding: try E2E.plaintext(blob, with: key), as: UTF8.self)
    }

    private static func object(_ data: Data) throws -> NSDictionary {
        try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }

    // MARK: Reading

    /// What the app reads from the messages, in a form TypeScript can compare with its own.
    private static func read(snapshot: String, history: String, key: SymmetricKey) throws -> Vectors.Expected {
        let vault = SessionVault(key: key)
        guard case .snapshot(let wireSessions, let wireMachines) = try JSONDecoder().decode(RelayMessage.self, from: Data(snapshot.utf8)),
            case .history(_, let wireEntries) = try JSONDecoder().decode(RelayMessage.self, from: Data(history.utf8))
        else { throw E2E.Failure.invalidBlob }
        let machines = vault.machines(wireMachines)
        let entries = vault.entries(wireEntries)
        return Vectors.Expected(
            machines: machines.map {
                .init(
                    id: $0.id, name: $0.name, platform: $0.platform, createdAt: milliseconds($0.createdAt),
                    lastSeen: $0.lastSeen.flatMap(milliseconds), online: $0.online, agentVersion: $0.agentVersion, health: $0.health)
            },
            sessions: wireSessions.map { session(vault.session($0, machines: machines)) },
            entries: entries,
            chat: ChatItem.build(from: entries).map { item in
                switch item {
                case .user(let entry): .init(kind: "user", id: entry.id, result: nil)
                case .assistant(let entry): .init(kind: "assistant", id: entry.id, result: nil)
                case .system(let entry): .init(kind: "system", id: entry.id, result: nil)
                case .tool(let call, let result): .init(kind: "tool", id: call.id, result: result?.id)
                }
            })
    }

    private static func session(_ s: SessionSummary) -> Vectors.Session {
        func limit(_ limit: UsageLimit?) -> Vectors.Limit? {
            limit.map { Vectors.Limit(usedPercent: $0.usedPercent, resetsAt: milliseconds($0.resetsAt)) }
        }
        return Vectors.Session(
            id: s.id, machineId: s.machineId, machine: s.machine, platform: s.platform, cwd: s.cwd, project: s.project, title: s.title,
            status: s.status.rawValue, statusText: s.statusText, displayStatusText: s.displayStatusText, agentOnline: s.agentOnline,
            canChat: s.canChat,
            pendingPermissions: s.pendingPermissions.map {
                .init(requestId: $0.requestId, toolName: $0.toolName, description: $0.description, inputPreview: $0.inputPreview, ts: $0.ts)
            },
            costUSD: s.costUSD, tokens: s.tokens,
            context: s.context.map { .init(usedTokens: $0.usedTokens, windowTokens: $0.windowTokens) },
            startedAt: milliseconds(s.startedAt), lastActivity: milliseconds(s.lastActivity), lastMessage: s.lastMessage,
            fiveHourLimit: limit(s.fiveHourLimit), sevenDayLimit: limit(s.sevenDayLimit), terminal: s.terminal,
            commands: s.commands.map(\.rawValue).sorted(), model: s.model, modelName: s.modelName, modelFamily: s.modelFamily?.rawValue,
            acceptsCommands: s.acceptsCommands, branch: s.branch, name: s.name)
    }

    /// Dates the app could not read are `distantPast`; TypeScript has null for them.
    private static func milliseconds(_ date: Date) -> Double? {
        date == .distantPast ? nil : (date.timeIntervalSince1970 * 1000).rounded()
    }
}

private struct Vectors: Codable {
    struct Blob: Codable { let name: String; let blob: String; let plaintext: String }
    struct Share: Codable { let text: String; let relay: String; let token: String; let key: String }
    struct Token: Codable {
        let token: String
        let relay: String
        let account: String
        let secret: String
        let key: String
    }
    struct Machine: Codable, Equatable {
        let id: String
        let name: String
        let platform: String?
        let createdAt: Double?
        let lastSeen: Double?
        let online: Bool
        let agentVersion: String?
        let health: MachineHealth?
    }
    struct Permission: Codable, Equatable {
        let requestId: String
        let toolName: String
        let description: String
        let inputPreview: String
        let ts: String
    }
    struct Context: Codable, Equatable { let usedTokens: Int; let windowTokens: Int }
    struct Limit: Codable, Equatable { let usedPercent: Double; let resetsAt: Double? }
    struct Session: Codable, Equatable {
        let id: String
        let machineId: String
        let machine: String
        let platform: String?
        let cwd: String
        let project: String
        let title: String?
        let status: String
        let statusText: String?
        let displayStatusText: String
        let agentOnline: Bool
        let canChat: Bool
        let pendingPermissions: [Permission]
        let costUSD: Double?
        let tokens: TokenCounts?
        let context: Context?
        let startedAt: Double?
        let lastActivity: Double?
        let lastMessage: String?
        let fiveHourLimit: Limit?
        let sevenDayLimit: Limit?
        let terminal: Bool
        let commands: [String]
        let model: String?
        let modelName: String?
        let modelFamily: String?
        let acceptsCommands: Bool
        let branch: String?
        let name: String?
    }
    struct ChatRow: Codable, Equatable { let kind: String; let id: String; let result: String? }
    struct Expected: Codable, Equatable {
        let machines: [Machine]
        let sessions: [Session]
        let entries: [Entry]
        let chat: [ChatRow]
    }

    let about: String
    let key: String
    let blobs: [Blob]
    let accountToken: Token
    let snapshot: String
    let history: String
    let expected: Expected
    let shareLink: Share
}
