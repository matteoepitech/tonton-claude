import Foundation

/// What the desktop and Notification Center widget shows, written by the app for the widget to read. Only what the widget
/// draws goes in: each session's project, machine, state and since when. Never conversations, prompts, status texts or
/// folders, which stay in the app.
public struct WidgetSnapshot: Codable, Equatable, Sendable {
    public struct Session: Codable, Equatable, Identifiable, Sendable {
        public let id: String
        public let project: String
        public let machine: String
        public let status: SessionStatus
        /// When the session got into this state, as far as the app saw it.
        public let since: Date

        public init(id: String, project: String, machine: String, status: SessionStatus, since: Date) {
            self.id = id
            self.project = project
            self.machine = machine
            self.status = status
            self.since = since
        }

        /// Opens the notch on this session.
        public var link: URL? { WidgetSnapshot.link(to: id) }
    }

    /// The widget's kind, which the app names to reload it.
    public static let kind = "sessions"
    /// How many sessions the snapshot lists at most: more than the large widget shows, and the file stays small.
    public static let limit = 24

    /// False once the app has quit: the widget says so instead of showing states that no longer change.
    public let running: Bool
    /// The ones that need the user first, then working, done and closed, the most recent first in each group.
    public let sessions: [Session]
    /// Live sessions that need the user, that work, and that are done, counted before the list is cut to `limit`.
    public let needYou: Int
    public let working: Int
    public let done: Int

    public init(running: Bool, sessions: [Session], needYou: Int, working: Int, done: Int) {
        self.running = running
        self.sessions = sessions
        self.needYou = needYou
        self.working = working
        self.done = done
    }

    /// What the widget shows once the app has quit: nothing about the sessions stays in the shared file.
    public static let stopped = WidgetSnapshot(running: false, sessions: [], needYou: 0, working: 0, done: 0)

    /// The sessions the notch shows, for the widget. A session still in the state `previous` saw keeps its `since`, so
    /// the widget can say how long it has been working or waiting.
    public init(_ summaries: [SessionSummary], previous: WidgetSnapshot?) {
        let before = Dictionary((previous?.sessions ?? []).map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let ordered = summaries.sorted { lhs, rhs in
            let ranks = (Self.rank(lhs.status), Self.rank(rhs.status))
            return ranks.0 != ranks.1 ? ranks.0 < ranks.1 : lhs.lastActivity > rhs.lastActivity
        }
        sessions = ordered.prefix(Self.limit).map { summary in
            let kept = before[summary.id].flatMap { $0.status == summary.status ? $0.since : nil }
            return Session(
                // The name the user gave the session, as the notch shows it.
                id: summary.id, project: summary.displayName, machine: summary.machine, status: summary.status,
                since: kept ?? summary.lastActivity)
        }
        running = true
        needYou = summaries.filter { $0.status.needsAttention }.count
        working = summaries.filter { $0.status == .working || $0.status == .starting }.count
        done = summaries.filter { $0.status == .idle }.count
    }

    /// Whether the widget would draw something else than with `previous`. Times alone don't count: the widget's relative
    /// dates move by themselves, and every reload spends some of the budget macOS gives the widget.
    public func differs(from previous: WidgetSnapshot?) -> Bool {
        guard let previous else { return true }
        let key = { (snapshot: WidgetSnapshot) in snapshot.sessions.map { [$0.id, $0.project, $0.machine, $0.status.rawValue] } }
        return running != previous.running || key(self) != key(previous)
            || [needYou, working, done] != [previous.needYou, previous.working, previous.done]
    }

    /// tonton://session/<id>, which the app opens on that session.
    public static func link(to sessionId: String) -> URL? {
        let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))
        guard let id = sessionId.addingPercentEncoding(withAllowedCharacters: allowed), !id.isEmpty
        else { return nil }
        return URL(string: "tonton://session/\(id)")
    }

    /// The session a tonton://session/<id> link names.
    public static func sessionId(in url: URL) -> String? {
        guard url.scheme == "tonton", url.host == "session" else { return nil }
        // From the encoded path: lastPathComponent splits at an encoded slash on some macOS versions and not others.
        let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? ""
        let id = String(path.drop { $0 == "/" }).removingPercentEncoding ?? ""
        return id.isEmpty ? nil : id
    }

    private static func rank(_ status: SessionStatus) -> Int {
        switch status {
        case .permission, .error, .waiting: 0
        case .working, .starting: 1
        case .idle: 2
        case .ended, .offline: 3
        }
    }
}

/// The snapshot's file, in the app group container the app shares with its widget. The group comes from the bundle's
/// Info.plist (`TontonAppGroup`), which scripts/build-app.sh only writes when it embeds the widget.
public struct WidgetShare: Sendable {
    public static let infoKey = "TontonAppGroup"
    public let file: URL

    public init(file: URL) {
        self.file = file
    }

    /// Nil when the bundle has no widget, or macOS gives no container for its group.
    public init?(bundle: Bundle) {
        guard let group = bundle.object(forInfoDictionaryKey: Self.infoKey) as? String, !group.isEmpty,
            let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
        else { return nil }
        file = container.appendingPathComponent("widget.json")
    }

    public func load() -> WidgetSnapshot? {
        guard let data = try? Data(contentsOf: file) else { return nil }
        return try? Self.decoder.decode(WidgetSnapshot.self, from: data)
    }

    /// Readable by the user only, like the app's other files.
    public func save(_ snapshot: WidgetSnapshot) throws {
        let data = try Self.encoder.encode(snapshot)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard FileManager.default.createFile(atPath: file.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: file.path])
        }
    }

    private static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        return encoder
    }

    private static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return decoder
    }
}
