import Foundation

/// A file Claude changed in a session, from its Write, Edit, MultiEdit and NotebookEdit calls. OpenCode's edit and write
/// tools arrive under the same names (agent/src/opencode/events.ts), so both tools fill it the same way.
public struct ChangedFile: Equatable, Identifiable, Sendable {
    /// As the call's summary holds it: absolute on the session's machine, which may be a Windows path.
    public let path: String
    /// The replacements of the calls that did not fail, oldest first. A Write call has none: it wrote the whole file.
    public var edits: [FileEdit] = []
    /// Calls that changed the file, failed ones left out.
    public var changes = 0
    /// Claude wrote the whole file at least once.
    public var written = false
    /// The last call on the file failed: the file may not hold what its diffs show.
    public var lastFailed = false
    /// When the last call on the file was made.
    public var lastChange: String

    public var id: String { path }

    public var name: String {
        path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? path
    }

    /// The path under the session's folder, or the whole path when it lies elsewhere.
    public func shownPath(in cwd: String) -> String {
        let folder = cwd.hasSuffix("/") || cwd.hasSuffix("\\") ? String(cwd.dropLast()) : cwd
        guard !folder.isEmpty, path.count > folder.count + 1, path.hasPrefix(folder) else { return path }
        let separator = path[path.index(path.startIndex, offsetBy: folder.count)]
        return separator == "/" || separator == "\\" ? String(path.dropFirst(folder.count + 1)) : path
    }
}

public enum ChangedFiles {
    static let tools: Set = ["Write", "Edit", "MultiEdit", "NotebookEdit"]

    /// The files the session changed, the most recently changed first.
    public static func list(_ entries: [Entry]) -> [ChangedFile] {
        let failed = Set(
            entries.filter { ($0.kind == .toolResult || $0.kind == .subagentResult) && $0.isError == true }.compactMap(\.toolUseId))
        var files: [String: ChangedFile] = [:]
        var order: [String: Int] = [:]
        for (index, entry) in entries.enumerated() {
            // A subagent's calls count too; the agent sends them without their diffs.
            guard entry.kind == .tool || entry.kind == .subagentTool, let name = entry.name, tools.contains(name),
                let path = path(of: entry)
            else { continue }
            var file = files[path] ?? ChangedFile(path: path, lastChange: entry.ts)
            let didFail = entry.toolUseId.map(failed.contains) ?? false
            file.lastFailed = didFail
            file.lastChange = entry.ts
            if !didFail {
                file.changes += 1
                file.edits += entry.edits ?? []
                if name == "Write" { file.written = true }
            }
            files[path] = file
            order[path] = index
        }
        return files.values.sorted { (order[$0.path] ?? 0) > (order[$1.path] ?? 0) }
    }

    /// The summary of a file call is its path, unless the agent cut it short or it is not a path at all (OpenCode's
    /// patch tool, which edits several files in one call).
    static func path(of entry: Entry) -> String? {
        guard let summary = entry.summary?.trimmingCharacters(in: .whitespaces), !summary.isEmpty, !summary.hasSuffix("…"),
            !summary.contains("\n"),
            summary.hasPrefix("/") || summary.hasPrefix("\\\\") || summary.wholeMatch(of: #/[A-Za-z]:[\\/].*/#) != nil
        else { return nil }
        return summary
    }
}
