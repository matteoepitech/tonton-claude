import Foundation
import OSLog
import TontonCore

/// Watches the OpenCode 2 sessions of this Mac through OpenCode's own service (see `OpenCodeLocal`), off the main thread,
/// and hands every change to `onChange`. It also sends what the notch asks them: messages, answers to permission requests,
/// compactions. Nothing goes anywhere but to that service, on this Mac.
final class OpenCodeLocalWatcher: @unchecked Sendable {
    private static let pollInterval: DispatchTimeInterval = .milliseconds(1500)
    private static let timeout: TimeInterval = 3

    /// Called on the main thread with every session and its entries, whenever something changed.
    var onChange: (@MainActor ([SessionSummary], [String: [Entry]]) -> Void)?

    private let queue = DispatchQueue(label: "tech.d3l.tontonclaude.opencode-sessions", qos: .utility)
    private var timer: DispatchSourceTimer?
    private struct Read {
        var updated: Date
        var conversation: OpenCodeLocal.Conversation
        var permissions: [PermissionRequest]
    }
    private var reads: [String: Read] = [:]
    /// Messages sent from the notch, waiting to show up in the conversation, and the entries they became.
    private var fromNotch: [String: [String]] = [:]
    private var notchEntries: Set<String> = []
    private var published: [SessionSummary] = []
    private var publishedEntries: [String: [Entry]] = [:]

    func start() {
        guard timer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: Self.pollInterval)
        timer.setEventHandler { [weak self] in self?.poll() }
        timer.resume()
        self.timer = timer
    }

    // MARK: What the notch asks

    func prompt(_ text: String, images: [OutgoingImage], to sessionId: String) {
        queue.async { [self] in
            let message = Self.withAttachments(text, images)
            fromNotch[sessionId, default: []].append(message)
            send("POST", "/api/session/\(sessionId)/prompt", ["text": message])
        }
    }

    func answer(_ requestId: String, allow: Bool, in sessionId: String) {
        queue.async { [self] in
            send("POST", "/api/session/\(sessionId)/permission/\(requestId)/reply", ["decision": allow ? "once" : "reject"])
        }
    }

    func compact(_ sessionId: String) {
        queue.async { [self] in send("POST", "/api/session/\(sessionId)/compact", [:]) }
    }

    // MARK: Reading

    private func poll() {
        guard let service = OpenCodeLocal.service() else { return publish([], [:]) }
        guard let list = request(service, "GET", "/api/session?limit=30") else { return }
        let listed = OpenCodeLocal.sessions(list)
        for session in listed {
            // A session is read again when it moved, and while it works or waits: its requests come and go.
            if let read = reads[session.id], read.updated == session.updated, !read.conversation.working, read.permissions.isEmpty {
                continue
            }
            guard let context = request(service, "GET", "/api/session/\(session.id)/context"),
                let pending = request(service, "GET", "/api/session/\(session.id)/permission")
            else { continue }
            reads[session.id] = Read(
                updated: session.updated, conversation: OpenCodeLocal.conversation(context), permissions: OpenCodeLocal.permissions(pending)
            )
        }
        let shown = Set(listed.map(\.id))
        reads = reads.filter { shown.contains($0.key) }
        var entries: [String: [Entry]] = [:]
        let sessions = listed.compactMap { session -> SessionSummary? in
            guard let read = reads[session.id] else { return nil }
            entries[session.id] = read.conversation.entries.map { markFromNotch($0, in: session.id) }
            return OpenCodeLocal.summary(session, read.conversation, permissions: read.permissions)
        }
        publish(sessions, entries)
    }

    /// The conversation says when a message came from the notch: the app takes its "sending…" bubble off.
    private func markFromNotch(_ entry: Entry, in sessionId: String) -> Entry {
        guard entry.kind == .user else { return entry }
        var entry = entry
        if notchEntries.contains(entry.id) {
            entry.viaNotch = true
        } else if let text = entry.text, let index = fromNotch[sessionId]?.firstIndex(of: text) {
            fromNotch[sessionId]?.remove(at: index)
            notchEntries.insert(entry.id)
            entry.viaNotch = true
        }
        return entry
    }

    private func publish(_ sessions: [SessionSummary], _ entries: [String: [Entry]]) {
        guard sessions != published || entries != publishedEntries, let onChange else { return }
        published = sessions
        publishedEntries = entries
        DispatchQueue.main.async { MainActor.assumeIsolated { onChange(sessions, entries) } }
    }

    // MARK: HTTP

    private func send(_ method: String, _ path: String, _ body: [String: Any]) {
        guard let service = OpenCodeLocal.service() else { return }
        if request(service, method, path, body: body) == nil { Logger.app.error("opencode: \(method) \(path) failed") }
    }

    /// Off the main thread only: it waits for the answer.
    private func request(_ service: OpenCodeLocal.Service, _ method: String, _ path: String, body: [String: Any]? = nil) -> Data? {
        guard let url = URL(string: path, relativeTo: service.url) else { return nil }
        var request = URLRequest(url: url, timeoutInterval: Self.timeout)
        request.httpMethod = method
        request.setValue(service.authorization, forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        let done = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var result: Data?
        URLSession.shared.dataTask(with: request) { data, response, _ in
            if let status = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status) { result = data ?? Data() }
            done.signal()
        }
        .resume()
        done.wait()
        return result
    }

    /// Images and files from the notch go in a folder of the app, and OpenCode gets their paths, as the agent does.
    private static func withAttachments(_ text: String, _ images: [OutgoingImage]) -> String {
        guard !images.isEmpty else { return text }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let inbox = support.appendingPathComponent("Tonton Claude/inbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let paths = images.enumerated().compactMap { index, image -> String? in
            guard let data = Data(base64Encoded: image.data) else { return nil }
            let name = image.name.replacingOccurrences(of: "[^A-Za-z0-9._-]", with: "_", options: .regularExpression)
            let file = inbox.appendingPathComponent("\(Int(Date().timeIntervalSince1970 * 1000))-\(index)-\(name)")
            return FileManager.default.createFile(atPath: file.path, contents: data, attributes: [.posixPermissions: 0o600])
                ? file.path : nil
        }
        return paths.isEmpty ? text : "\(text)\n\n[Attached from the notch: \(paths.joined(separator: ", "))]"
    }
}
