import Darwin
import Foundation
import TontonCore

/// The Codex sessions of this Mac, read straight from Codex's rollouts (see `CodexRollout`): like `LocalSessions` for
/// Claude Code, they show up in the notch without an agent, an account or a relay. Read only: a Codex session takes
/// messages only from what runs it. Codex keeps them in `$CODEX_HOME` (by default ~/.codex), one rollout per thread under
/// `sessions/YYYY/MM/DD/`, compressed to `.jsonl.zst` once a week old, and the names users gave threads in
/// `session_index.jsonl`, as agent/src/codex/home.ts reads them.
public enum CodexLocal {
    /// Rollouts not written to for this long stay out of the list, unless Codex has them open.
    public static let recent: TimeInterval = 12 * 3600
    /// A rollout's first line, its session_meta, holds the session's instructions: tens of kilobytes.
    static let firstLineBytes = 512 * 1024
    private static let day: TimeInterval = 86_400

    /// `$CODEX_HOME`, else ~/.codex. An app opened from the Finder has no CODEX_HOME: sessions elsewhere are found while
    /// Codex has them open.
    public static func home(
        environment: [String: String] = ProcessInfo.processInfo.environment, user: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> URL {
        if let home = environment["CODEX_HOME"], !home.isEmpty { return URL(fileURLWithPath: home, isDirectory: true) }
        return user.appendingPathComponent(".codex", isDirectory: true)
    }

    /// `<home>/sessions/YYYY/MM/DD/rollout-….jsonl` gives `<home>`, or nothing for a file elsewhere.
    public static func home(ofRollout file: URL) -> URL? {
        let sessions = file.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return sessions.lastPathComponent == "sessions" ? sessions.deletingLastPathComponent() : nil
    }

    /// The plain rollouts written to since `since`, from the day folders Codex names in local time, plus one either side
    /// for time zones. Compressed ones are left out: macOS has nothing to read zstd with, and they are a week old.
    public static func rollouts(in sessions: URL, since: Date, now: Date = Date(), calendar: Calendar = .current) -> [URL] {
        var folders: [URL] = []
        for at in stride(from: since.timeIntervalSince1970 - day, through: now.timeIntervalSince1970 + day, by: day) {
            let date = calendar.dateComponents([.year, .month, .day], from: Date(timeIntervalSince1970: at))
            guard let year = date.year, let month = date.month, let dayOfMonth = date.day else { continue }
            let folder = sessions.appendingPathComponent(String(format: "%04d/%02d/%02d", year, month, dayOfMonth), isDirectory: true)
            if !folders.contains(folder) { folders.append(folder) }
        }
        return folders.flatMap { folder in
            let files =
                (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey]))
            return (files ?? []).filter { isRollout($0.path) && (modified($0).map { $0 >= since } ?? false) }
        }
    }

    /// A plain rollout's name: `rollout-<time>-<thread id>.jsonl`.
    public static func isRollout(_ path: String) -> Bool {
        let name = (path as NSString).lastPathComponent
        return name.hasPrefix("rollout-") && name.hasSuffix(".jsonl")
    }

    public static func modified(_ file: URL) -> Date? {
        (try? FileManager.default.attributesOfItem(atPath: file.path))?[.modificationDate] as? Date
    }

    /// What the first line of a rollout says about its session.
    public enum FirstLine: Equatable {
        case session(CodexRollout.Session)
        /// No whole line yet: Codex is writing it.
        case notYet
        /// Something else, which a later read will not change.
        case other
    }

    /// The session_meta of a rollout, from its first line only: a long rollout is read from its end.
    public static func firstLine(of file: URL) -> FirstLine {
        guard let handle = try? FileHandle(forReadingFrom: file) else { return .notYet }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: firstLineBytes) else { return .notYet }
        // A first line longer than that is no session_meta Tonton knows.
        guard let newline = data.firstIndex(of: 0x0A) else { return data.count < firstLineBytes ? .notYet : .other }
        return CodexRollout.session(String(decoding: data[..<newline], as: UTF8.self)).map { .session($0) } ?? .other
    }

    /// The names users gave threads with /rename, by thread id.
    public static func threadNames(in home: URL) -> [String: String] {
        let index = home.appendingPathComponent("session_index.jsonl")
        return (try? String(contentsOf: index, encoding: .utf8)).map(CodexRollout.threadNames) ?? [:]
    }

    /// The same file whichever way it is written, as the system names the files a process has open.
    public static func realPath(_ path: String) -> String {
        guard let resolved = realpath(path, nil) else { return path }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    // MARK: Live sessions

    /// The rollouts Codex has open, wherever they are: Codex keeps a thread's rollout open until the thread shuts down, so
    /// a session is live while it is open, as a Claude Code session is while its process runs. Nil when this Mac's
    /// processes cannot be listed.
    public static func openRollouts() -> Set<String>? {
        guard let pids = processes() else { return nil }
        return Set(pids.filter { name(of: $0).localizedCaseInsensitiveContains("codex") }.flatMap(openFiles).filter(isRollout))
    }

    /// Every process of this Mac.
    static func processes() -> [pid_t]? {
        let count = proc_listallpids(nil, 0)
        guard count > 0 else { return nil }
        // Room for processes started in between.
        var pids = [pid_t](repeating: 0, count: Int(count) + 64)
        let listed = pids.withUnsafeMutableBytes { proc_listallpids($0.baseAddress, Int32($0.count)) }
        guard listed > 0 else { return nil }
        return Array(pids.prefix(Int(listed)).filter { $0 > 0 })
    }

    static func name(of pid: pid_t) -> String {
        var buffer = [CChar](repeating: 0, count: 256)
        guard proc_name(pid, &buffer, UInt32(buffer.count)) > 0 else { return "" }
        return String(cString: buffer)
    }

    /// The files a process has open, by their full path. Empty for another user's process.
    static func openFiles(of pid: pid_t) -> [String] {
        let size = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nil, 0)
        guard size > 0 else { return [] }
        let stride = MemoryLayout<proc_fdinfo>.stride
        var fds = [proc_fdinfo](repeating: proc_fdinfo(), count: Int(size) / stride + 16)
        let filled = fds.withUnsafeMutableBytes { proc_pidinfo(pid, PROC_PIDLISTFDS, 0, $0.baseAddress, Int32($0.count)) }
        guard filled > 0 else { return [] }
        return fds.prefix(Int(filled) / stride).compactMap { fd in
            guard fd.proc_fdtype == UInt32(PROX_FDTYPE_VNODE) else { return nil }
            var info = vnode_fdinfowithpath()
            let expected = Int32(MemoryLayout<vnode_fdinfowithpath>.size)
            guard proc_pidfdinfo(pid, fd.proc_fd, PROC_PIDFDVNODEPATHINFO, &info, expected) == expected else { return nil }
            return withUnsafeBytes(of: &info.pvip.vip_path) { bytes in
                String(decoding: bytes.prefix { $0 != 0 }, as: UTF8.self)
            }
        }
    }

    // MARK: The notch

    /// The session as the notch shows it. `live` is whether Codex has its rollout open, nil when that is not known: the
    /// rollout's turns say whether it works then.
    public static func summary(
        _ session: CodexRollout.Session, _ conversation: CodexConversation, name: String?, live: Bool?, modified: Date
    ) -> SessionSummary {
        let raw = session.cwd ?? ""
        let cwd = raw.hasSuffix("/") && raw.count > 1 ? String(raw.dropLast()) : raw
        let project = URL(fileURLWithPath: cwd).lastPathComponent
        let status: SessionStatus = live == false ? .ended : conversation.working ? .working : .idle
        return SessionSummary(
            id: session.sessionId, machineId: LocalSessions.machineId, machine: "This Mac", platform: "darwin", cwd: cwd,
            project: project.isEmpty ? cwd : project, title: name ?? conversation.title, status: status, statusText: nil,
            agentOnline: true, canChat: false, pendingPermissions: [], costUSD: nil, startedAt: session.started ?? modified,
            lastActivity: modified, lastMessage: conversation.lastMessage, fiveHourLimit: conversation.fiveHourLimit,
            sevenDayLimit: conversation.sevenDayLimit, tokens: conversation.tokens,
            context: conversation.contextTokens.map { ContextUsage(usedTokens: $0, windowTokens: conversation.contextWindow) },
            model: conversation.model, tool: CodingTool.codex.command, branch: session.branch,
            tasks: TodoList.progress(TodoList.latest(in: conversation.entries)))
    }
}
