import XCTest

@testable import TontonCore

/// How long a big history takes to become a conversation, step by step. Only with TONTON_BENCH=1: timings depend on the
/// machine, so nothing is asserted on them.
final class HistoryLoadBenchmark: XCTestCase {
    func testWhereTheTimeGoes() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["TONTON_BENCH"] == "1", "set TONTON_BENCH=1 to run")
        let keyText = E2E.newKey()
        let key = try E2E.key(fromBase64URL: keyText)
        // What the relay can hold for one session: 800 entries, the last 40 images kept by the agent, up to 16 MB.
        let text = String(repeating: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ", count: 30)
        let image = ImageData(mediaType: "image/png", data: String(repeating: "iVBORw0KGgo", count: 25_000))
        var entries: [Entry] = []
        for i in 0..<200 {
            entries.append(
                Entry(id: "u\(i)", ts: "2026-10-27T10:00:00Z", kind: .user, text: "Do step \(i)", images: i % 5 == 0 ? [image] : nil))
            entries.append(Entry(id: "a\(i)", ts: "2026-10-27T10:00:01Z", kind: .assistant, text: text))
            entries.append(Entry(id: "t\(i)", ts: "2026-10-27T10:00:02Z", kind: .tool, toolUseId: "c\(i)", name: "Bash", summary: "make"))
            entries.append(Entry(id: "r\(i)", ts: "2026-10-27T10:00:03Z", kind: .toolResult, text: text + text, toolUseId: "c\(i)"))
        }
        let wire: [[String: Any]] = try entries.map { ["id": $0.id, "ts": $0.ts, "blob": try E2E.seal($0, with: key)] }
        let message = try JSONSerialization.data(withJSONObject: ["t": "history", "sessionId": "s1", "entries": wire])
        let vault = SessionVault(key: key)

        func time<T>(_ label: String, _ run: () throws -> T) rethrows -> T {
            let start = ContinuousClock.now
            let value = try run()
            print("BENCH \(label): \(start.duration(to: .now))")
            return value
        }
        print("BENCH message: \(message.count / 1024) KB, \(entries.count) entries")
        let decoded = try time("decode the relay message") { try JSONDecoder().decode(RelayMessage.self, from: message) }
        guard case .history(_, let sealed) = decoded else { return XCTFail("not a history") }
        let opened = time("open every entry") { vault.entries(sealed) }
        XCTAssertEqual(opened.count, entries.count)
        _ = time("build the chat items") { ChatItem.build(from: opened) }
        // What a relay sends first to an app that subscribes with `latestFirst` (relay/src/limits.ts).
        var recent: [WireEntry] = []
        var bytes = 0
        for entry in sealed.reversed() {
            guard recent.count < 60, bytes + entry.blob.count <= 256 * 1024 else { break }
            recent.insert(entry, at: 0)
            bytes += entry.blob.count
        }
        let recentWire: [[String: Any]] = recent.map { ["id": $0.id, "ts": $0.ts, "blob": $0.blob] }
        let recentMessage = try JSONSerialization.data(withJSONObject: [
            "t": "history", "sessionId": "s1", "entries": recentWire, "partial": true,
        ])
        print("BENCH latest entries first: \(recentMessage.count / 1024) KB, \(recent.count) entries")
        let decodedRecent = try time("decode them") { try JSONDecoder().decode(RelayMessage.self, from: recentMessage) }
        guard case .recentHistory(_, let recentSealed) = decodedRecent else { return XCTFail("not a partial history") }
        _ = time("open them") { vault.entries(recentSealed) }
    }
}
