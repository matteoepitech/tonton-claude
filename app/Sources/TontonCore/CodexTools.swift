import Foundation

/// Codex's tools under the names the notch knows from Claude Code (Bash, Edit, TodoWrite…), and the files its patches
/// change, as agent/src/codex/tools.ts and patch.ts read them: the chat, the changed files and the task list then read a
/// Codex session as they read a Claude Code one. Both sides check shared/test/codex-tool-names.json.
public enum CodexTools {
    /// Codex's tools that run a command: `shell` and `container.exec` take an argv.
    static let shellTools: Set = ["shell", "container.exec", "shell_command", "exec_command", "local_shell"]
    /// Files per patch: a patch that touches more is a refactor, and the first ones say what it is.
    static let maxPatchFiles = 50

    /// The Claude Code name of each built-in tool of Codex that has one.
    static let claudeNames: [String: String] = [
        "shell": "Bash", "container.exec": "Bash", "shell_command": "Bash", "exec_command": "Bash", "local_shell": "Bash",
        "update_plan": "TodoWrite", "view_image": "Read", "web_search": "WebSearch", "spawn_agent": "Task",
        "request_user_input": "AskUserQuestion", "tool_search": "ToolSearch", "list_mcp_resources": "ListMcpResourcesTool",
        "read_mcp_resource": "ReadMcpResourceTool",
    ]

    /// A tool of Codex under Claude Code's name. An MCP tool comes as its namespace and its name, which Codex joins as
    /// `mcp__<server>__<tool>`, trimming the `_` the namespace ends with and the name starts with. `apply_patch` has no
    /// single name: each file it touches becomes an Edit or a Write. Any other name stays as it is.
    public static func name(_ name: String, namespace: String? = nil) -> String {
        if let namespace, !namespace.isEmpty {
            let joined = "\(namespace.replacing(#/_+$/#, with: ""))__\(name.replacing(#/^_+/#, with: ""))"
            return joined.hasPrefix("mcp__") ? joined : "mcp__\(joined)"
        }
        return claudeNames[name] ?? name
    }

    /// The command of a shell call, as one line a person would type: `["bash", "-lc", "cargo test"]` is `cargo test`.
    /// Codex's tools give it as `cmd` (exec_command), `command` as a string (shell_command) or as an argv (shell).
    static func shellCommand(_ input: [String: Any]) -> String? {
        let value = input["cmd"].flatMap { $0 is NSNull ? nil : $0 } ?? input["command"]
        if let command = value as? String { return command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : command }
        guard let parts = value as? [Any] else { return nil }
        let argv = parts.compactMap { $0 as? String }
        guard argv.count == parts.count else { return nil }
        if argv.count == 3, argv[0].firstMatch(of: #/(^|[\\\/])(ba|z|da|k)?sh$/#) != nil, argv[1].wholeMatch(of: #/-l?c/#) != nil {
            return argv[2]
        }
        if let flag = argv.firstIndex(where: { $0.lowercased() == "-command" || $0.lowercased() == "-c" }), flag > 0,
            flag == argv.count - 2, argv[0].range(of: "powershell|pwsh", options: [.regularExpression, .caseInsensitive]) != nil
        {
            return argv[flag + 1]
        }
        let line = argv.map { part in
            part.wholeMatch(of: #/[A-Za-z0-9_.\/:=@%+-]+/#) != nil ? part : "'\(part.replacingOccurrences(of: "'", with: #"'\''"#))'"
        }
        .joined(separator: " ")
        return line.isEmpty ? nil : line
    }

    /// A file a patch changes: Write for a new file, Edit for a change or a deletion, where it ends up, its replacements.
    struct PatchFile: Equatable {
        let tool: String
        let path: String
        let edits: [FileEdit]
    }

    private struct Hunk {
        var old: [String] = []
        var new: [String] = []

        mutating func add(_ line: String) {
            if line.hasPrefix("-") {
                old.append(String(line.dropFirst()))
            } else if line.hasPrefix("+") {
                new.append(String(line.dropFirst()))
            } else if line.hasPrefix(" ") {
                old.append(String(line.dropFirst()))
                new.append(String(line.dropFirst()))
            }
        }
    }

    /// The files of a patch in Codex's format: `*** Begin Patch`, then `*** Add File: <path>` with `+` lines, `*** Delete
    /// File: <path>`, or `*** Update File: <path>` with an optional `*** Move to: <path>` and hunks of ` `, `-` and `+` lines
    /// after `@@`, then `*** End Patch`. Paths are relative to the session's folder.
    static func patchFiles(_ patch: String, cwd: String?) -> [PatchFile] {
        var files: [PatchFile] = []
        var current: (tool: String, path: String, hunks: [Hunk])?
        func close() {
            guard let open = current else { return }
            let hunks = open.hunks.filter { !$0.old.isEmpty || !$0.new.isEmpty }
            files.append(
                PatchFile(tool: open.tool, path: absolute(open.path, cwd), edits: open.tool == "Write" ? [] : replacements(hunks)))
            current = nil
        }
        for line in patch.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
            if let header = line.wholeMatch(of: #/\*\*\* (Add|Delete|Update) File: (.+)/#) {
                close()
                if files.count >= maxPatchFiles { break }
                current = (header.1 == "Add" ? "Write" : "Edit", header.2.trimmingCharacters(in: .whitespaces), [])
                continue
            }
            guard current != nil else { continue }
            if let move = line.wholeMatch(of: #/\*\*\* Move to: (.+)/#) {
                current?.path = move.1.trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("*** ") {
                close()
            } else if line.hasPrefix("@@") || current?.hunks.isEmpty == true {
                var hunk = Hunk()
                if !line.hasPrefix("@@") { hunk.add(line) }
                current?.hunks.append(hunk)
            } else if let last = current?.hunks.indices.last {
                current?.hunks[last].add(line)
            }
        }
        close()
        return files
    }

    /// A file change of the `patch_apply_end` event Codex writes once it applied a patch, which also covers one run through
    /// the shell: `{ type: add, content }`, `{ type: delete, content }`, or `{ type: update, unified_diff, move_path }`.
    static func appliedFile(_ path: String, _ change: Any?) -> PatchFile? {
        guard !path.isEmpty, let fields = change as? [String: Any] else { return nil }
        switch fields["type"] as? String {
        case "add":
            return PatchFile(tool: "Write", path: path, edits: [])
        case "delete":
            let content = fields["content"] as? String ?? ""
            let hunk = Hunk(old: content.components(separatedBy: "\n"), new: [])
            return PatchFile(tool: "Edit", path: path, edits: content.isEmpty ? [] : replacements([hunk]))
        case "update":
            let moved = (fields["move_path"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? path
            var hunks: [Hunk] = []
            let diff = (fields["unified_diff"] as? String ?? "").replacingOccurrences(of: "\r\n", with: "\n")
            for line in diff.components(separatedBy: "\n") where !line.hasPrefix("--- ") && !line.hasPrefix("+++ ") {
                if line.hasPrefix("@@") {
                    hunks.append(Hunk())
                } else if !hunks.isEmpty {
                    hunks[hunks.count - 1].add(line)
                }
            }
            return PatchFile(tool: "Edit", path: moved, edits: replacements(hunks))
        default:
            return nil
        }
    }

    /// Cut as an Edit's are.
    private static func replacements(_ hunks: [Hunk]) -> [FileEdit] {
        let edits = hunks.map { ["old_string": $0.old.joined(separator: "\n"), "new_string": $0.new.joined(separator: "\n")] }
        return Transcript.fileEdits("MultiEdit", ["edits": edits])
    }

    /// `path` in `cwd`, `.` and `..` resolved, as node's `path.join` writes it.
    static func absolute(_ path: String, _ cwd: String?) -> String {
        guard let cwd, !cwd.isEmpty, !path.hasPrefix("/") else { return path }
        var parts: [Substring] = []
        for part in "\(cwd)/\(path)".split(separator: "/") {
            if part == ".." {
                _ = parts.popLast()
            } else if part != "." {
                parts.append(part)
            }
        }
        return "/" + parts.joined(separator: "/")
    }
}
