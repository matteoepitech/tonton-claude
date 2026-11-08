import XCTest

@testable import TontonCore

/// Codex's rollouts read as the agent reads them (agent/test/codex-rollout.test.ts, on the same fixture): the conversation,
/// its tools under Claude Code's names, the changed files, the task list, the tokens, and the ids the agent gives it.
final class CodexRolloutTests: XCTestCase {
    private static let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../..")

    /// Made by hand in the shapes of Codex 0.142.2, with nothing from a real session.
    private func fixture() throws -> [String] {
        let url = Self.repository.appendingPathComponent("agent/test/fixtures/codex-0.142.2.jsonl")
        return try String(contentsOf: url, encoding: .utf8).components(separatedBy: "\n").filter { !$0.isEmpty }
    }

    private func parsed(_ lines: [String]) -> [CodexRollout.Line] {
        var rollout = CodexRollout()
        return lines.map { rollout.line($0) }
    }

    private func line(_ type: String, _ payload: [String: Any]) throws -> String {
        let object: [String: Any] = ["timestamp": "2026-11-04T10:00:00.000Z", "type": type, "payload": payload]
        return String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self)
    }

    private func json(_ object: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
    }

    func testTheConversationTheUserSawWithItsToolsUnderClaudeCodesNames() throws {
        let entries = parsed(try fixture()).flatMap(\.entries)
        let shown = entries.map { [$0.kind.rawValue, $0.name ?? $0.text ?? ""] }
        XCTAssertEqual(
            shown,
            [
                ["user", "Fix the failing test [Image #1]"],
                ["system", "Reproducing the failure"],
                ["assistant", "Running the tests to see the failure."],
                ["tool", "Bash"],
                [
                    "tool_result",
                    "Exit code 1\nsrc/math.test.ts:\n(fail) add > adds two numbers [0.21ms]\n\n 0 pass\n 1 fail\nRan 1 test across 1 file.\n",
                ],
                ["tool", "TodoWrite"],
                ["tool_result", "Plan updated"],
                ["tool", "Edit"],
                ["tool", "Write"],
                ["tool_result", "Success. Updated the following files:\nM src/math.ts\nA docs/math.md\n"],
                ["tool", "Bash"],
                [
                    "tool_result",
                    "src/math.test.ts:\n(pass) add > adds two numbers [0.18ms]\n\n 1 pass\n 0 fail\nRan 1 test across 1 file.\n",
                ],
                ["tool", "Bash"],
                [
                    "tool_result",
                    "[main 1a2b3c4] fix: add adds\n 2 files changed, 4 insertions(+), 1 deletion(-)\n create mode 100644 docs/math.md\n",
                ],
                ["tool", "Bash"],
                ["tool_result", "Command running in background\n"],
                ["tool", "Bash"],
                ["tool_result", "To github.com:hero/hero.git\n   0a1b2c3..1a2b3c4  main -> main\n"],
                ["tool", "TodoWrite"],
                ["tool_result", "Plan updated"],
                ["assistant", "`add` subtracted. It adds now, the test passes, and the fix is pushed to `main`."],
                ["user", "Which flags does bun test take?"],
                ["tool", "WebSearch"],
                ["tool_result", ""],
                ["tool", "mcp__tonton__cluster_status"],
                ["tool_result", "Status posted."],
                ["tool", "Read"],
                ["tool_result", ""],
                ["tool", "Bash"],
                ["tool_result", "math.test.ts\nmath.ts\n"],
                ["tool", "Bash"],
                ["tool_result", "exec command rejected by user"],
                ["system", "Interrupted by user"],
                ["user", "Say hello"],
                ["tool", "Bash"],
                ["tool_result", "hello\n"],
                ["system", "Conversation compacted"],
                ["assistant", "Hello!"],
            ])
        // The instructions Codex adds as the developer's and the user's, the tool search and lines of a newer Codex: none.
        XCTAssertFalse(entries.contains { ($0.text ?? "").contains("environment_context") })
        XCTAssertEqual(Set(entries.map(\.id)).count, entries.count)
    }

    func testTheEntriesHaveTheIdsTheAgentGivesThem() throws {
        let entries = parsed(try fixture()).flatMap(\.entries)
        // As agent/src/codex/rollout.ts writes them: `cx-` and Bun.hash of the line, in base 36.
        XCTAssertEqual(entries.first?.id, "cx-35mu9158dezlx")
        XCTAssertEqual(
            entries.filter { $0.toolUseId == "call_patch1" }.map(\.id), ["cx-lgenyhu4qwkp:0", "cx-lgenyhu4qwkp:1", "cx-253n4yq3ge3bp"])
        XCTAssertEqual(entries.last?.id, "cx-2qn3f210xfi1w")
        XCTAssertEqual(String(Wyhash.hash("".utf8), radix: 36), "27k1wwwhf13t")
    }

    func testSummariesResultsAndErrorsAsTheNotchShowsClaudeCodeCalls() throws {
        let entries = parsed(try fixture()).flatMap(\.entries)
        let tools = Dictionary(entries.filter { $0.kind == .tool }.map { ($0.toolUseId ?? "", $0.summary ?? "") }) { first, _ in first }
        XCTAssertEqual(tools["call_commit"], "git commit -am 'fix: add adds'")
        XCTAssertEqual(tools["call_poll"], "git push")
        XCTAssertEqual(tools["ws_1"], "bun test flags")
        XCTAssertEqual(tools["call_mcp"], "Reading bun docs")
        XCTAssertEqual(tools["call_view"], "/work/hero/shot.png")
        XCTAssertEqual(tools["call_echo"], "echo hello")
        XCTAssertEqual(entries.filter { $0.kind == .toolResult && $0.isError == true }.map(\.toolUseId), ["call_test1", "call_rm"])
    }

    func testThePastedScreenshotIsOnThePromptAndTheViewedOneOnItsResult() throws {
        let entries = parsed(try fixture()).flatMap(\.entries)
        let prompt = entries.first { $0.kind == .user }
        let viewed = entries.first { $0.kind == .toolResult && $0.toolUseId == "call_view" }
        for entry in [prompt, viewed] {
            XCTAssertEqual(entry?.images?.map(\.mediaType), ["image/png"])
            XCTAssertEqual(entry?.images?.first.flatMap { Data(base64Encoded: $0.data) }?.prefix(4), Data([0x89, 0x50, 0x4E, 0x47]))
        }
    }

    func testThePatchsFilesAreChangedFilesWithTheirEdits() throws {
        let files = ChangedFiles.list(parsed(try fixture()).flatMap(\.entries))
        XCTAssertEqual(files.map(\.path), ["/work/hero/docs/math.md", "/work/hero/src/math.ts"])
        XCTAssertEqual(files.map(\.written), [true, false])
        XCTAssertEqual(files.map(\.changes), [1, 1])
        XCTAssertEqual(files.last?.edits, [FileEdit(oldText: "  return a - b\n}", newText: "  return a + b\n}")])
    }

    func testUpdatePlanIsTheTaskList() throws {
        let entries = parsed(try fixture()).flatMap(\.entries)
        let plans = entries.filter { $0.kind == .tool && $0.name == "TodoWrite" }
        XCTAssertEqual(
            plans.first?.todos,
            [
                TodoItem(content: "Reproduce the failure", status: .completed), TodoItem(content: "Fix add()", status: .inProgress),
                TodoItem(content: "Run the tests again", status: .pending),
            ])
        let second = try XCTUnwrap(entries.firstIndex { $0.id == plans.last?.id })
        XCTAssertEqual(TodoList.progress(TodoList.latest(in: Array(entries[..<second]))), TaskProgress(done: 1, total: 3))
        // All done: the progress goes, as for Claude Code.
        XCTAssertNil(TodoList.progress(TodoList.latest(in: entries)))
    }

    func testTheSessionItsModelWindowTokensAndTurns() throws {
        let lines = parsed(try fixture())
        XCTAssertEqual(lines.compactMap(\.title), ["Fix the failing test [Image #1]"])
        XCTAssertEqual(lines.compactMap(\.model).first, "gpt-5.5")
        XCTAssertEqual(lines.compactMap(\.contextWindow).first, 258_400)
        let session = try XCTUnwrap(lines.compactMap(\.session).first)
        XCTAssertEqual(session.sessionId, "01a2b3c4-5d6e-7f80-91a2-b3c4d5e6f708")
        XCTAssertEqual(session.threadId, "01a2b3c4-5d6e-7f80-91a2-b3c4d5e6f708")
        XCTAssertEqual(session.cwd, "/work/hero")
        XCTAssertEqual(session.branch, "main")
        XCTAssertFalse(session.subagent)
        XCTAssertEqual(session.started, ISO8601.parse("2026-11-04T10:00:00.000Z"))
        // Cached input is apart, as Claude Code's cache reads are; the token_count with no info counts nothing.
        XCTAssertEqual(
            lines.compactMap(\.usage),
            [
                Transcript.ResponseUsage(requestId: "codex-total-12900", tokens: TokenCounts(input: 4000, output: 300, cacheRead: 8000)),
                Transcript.ResponseUsage(requestId: "codex-total-25400", tokens: TokenCounts(input: 1100, output: 400, cacheRead: 11000)),
                Transcript.ResponseUsage(requestId: "codex-total-31000", tokens: TokenCounts(input: 4000, output: 20)),
            ])
        XCTAssertEqual(lines.filter(\.compacted).count, 2)
        XCTAssertEqual(lines.compactMap(\.status), [.working, .idle, .working, .idle, .working, .idle])
    }

    func testTheConversationAsTheNotchShowsIt() throws {
        let lines = try fixture()
        var conversation = CodexConversation()
        conversation.apply(TranscriptTail.Read(lines: Array(lines.prefix(12))))
        XCTAssertTrue(conversation.working)
        XCTAssertEqual(conversation.title, "Fix the failing test [Image #1]")
        conversation.apply(TranscriptTail.Read(lines: Array(lines.dropFirst(12))))
        XCTAssertFalse(conversation.working)
        XCTAssertEqual(conversation.model, "gpt-5.5")
        XCTAssertEqual(conversation.tokens, TokenCounts(input: 9100, output: 720, cacheRead: 19000))
        XCTAssertEqual(conversation.contextTokens, 4000)
        XCTAssertEqual(conversation.contextWindow, 258_400)
        XCTAssertEqual(conversation.lastMessage, "Hello!")
        // The ChatGPT plan's windows of Codex's latest reading, as the agent sends them (agent/test/codex-limits.test.ts).
        XCTAssertEqual(
            conversation.fiveHourLimit, UsageLimit(usedPercent: 14, resetsAt: try XCTUnwrap(ISO8601.parse("2026-11-04T13:46:40Z"))))
        XCTAssertEqual(
            conversation.sevenDayLimit, UsageLimit(usedPercent: 3, resetsAt: try XCTUnwrap(ISO8601.parse("2026-11-10T08:40:00Z"))))
        let windows = { (limits: [String: Any]) in CodexRollout.planWindows(limits) }
        XCTAssertNil(windows(["primary": ["used_percent": true, "resets_at": 1]]))
        XCTAssertEqual(windows(["rate_limit_reached_type": "rate_limit_reached"]), CodexRollout.PlanWindows())
        // By its length first: a weekly window in the first place is still the weekly one; one of another length is left out.
        let weekly = windows([
            "primary": ["used_percent": 40, "window_minutes": 10080, "resets_at": 1_800_000_000],
            "secondary": ["used_percent": 5, "window_minutes": 60, "resets_at": 1_800_000_000],
        ])
        XCTAssertEqual(weekly?.sevenDay?.usedPercent, 40)
        XCTAssertNil(weekly?.fiveHour)
        XCTAssertEqual(conversation.entries.count, 38)
        // The rollout was replaced: what was read before no longer counts.
        conversation.apply(TranscriptTail.Read(lines: [lines[0], lines[6]], reset: true))
        XCTAssertEqual(conversation.entries.map(\.text), ["Fix the failing test [Image #1]"])
        XCTAssertNil(conversation.tokens)
    }

    func testReadFromTheMiddleItGivesTheSameIdsAndNeverCrashes() throws {
        let lines = try fixture()
        let ids = Set(parsed(lines).flatMap(\.entries).map(\.id))
        let half = parsed(Array(lines.dropFirst(30))).flatMap(\.entries)
        XCTAssertFalse(half.isEmpty)
        for entry in half { XCTAssertTrue(ids.contains(entry.id), entry.id) }
        var rollout = CodexRollout()
        for raw in [
            "", "null", "[]", #"{"type":"event_msg"}"#, #"{"payload":3}"#, #"{"type":"response_item","payload":{"type":"function_call"}}"#,
        ] {
            XCTAssertEqual(rollout.line(raw).entries, [], raw)
        }
        // Each line cut short, each field of the wrong type.
        for raw in lines {
            for cut in [raw.count / 3, raw.count / 2] { _ = rollout.line(String(raw.prefix(cut))) }
            _ = rollout.line(raw.replacing(#/"[^"]*"/#, with: "7"))
            _ = rollout.line(raw.replacing(#/:"[^"]*"/#, with: ":null"))
        }
    }

    func testAPatchRunThroughTheShellShowsItsFilesFromWhatCodexApplied() throws {
        var rollout = CodexRollout()
        let patch = "*** Begin Patch\n*** Delete File: old.txt\n*** End Patch"
        let call = rollout.line(
            try line(
                "response_item",
                ["type": "function_call", "name": "shell", "arguments": try json(["command": ["apply_patch", patch]]), "call_id": "c1"]))
        XCTAssertEqual(call.entries.map(\.name), ["Bash"])
        let changes: [String: Any] = [
            "/w/old.txt": ["type": "delete", "content": "bye\n"],
            "/w/a.ts": ["type": "update", "unified_diff": "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n", "move_path": "/w/b.ts"],
        ]
        // The order of the line, which the agent numbers the files in: not the order of the keys' names.
        let raw =
            #"{"timestamp":"2026-11-04T10:00:00.000Z","type":"event_msg","payload":{"type":"patch_apply_end","call_id":"c1","#
            + #""success":true,"changes":{"/w/old.txt":\#(try json(changes["/w/old.txt"] as Any)),"#
            + #""/w/a.ts":\#(try json(changes["/w/a.ts"] as Any))}}}"#
        let applied = rollout.line(raw).entries
        XCTAssertEqual(applied.map(\.summary), ["/w/old.txt", "/w/b.ts"])
        XCTAssertEqual(applied.map(\.toolUseId), ["c1", "c1"])
        XCTAssertEqual(applied.map(\.edits), [[FileEdit(oldText: "bye\n", newText: "")], [FileEdit(oldText: "x", newText: "y")]])
    }

    func testAPatchCodexCouldNotApplyIsAFailedCall() throws {
        var rollout = CodexRollout()
        let patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** End Patch\n"
        let entries = try [
            line("turn_context", ["cwd": "/w", "model": "gpt-5.5"]),
            line(
                "response_item", ["type": "function_call", "name": "apply_patch", "arguments": try json(["input": patch]), "call_id": "p1"]),
            line("event_msg", ["type": "patch_apply_end", "call_id": "p1", "success": false, "changes": [String: Any]()]),
            line(
                "response_item",
                ["type": "function_call_output", "call_id": "p1", "output": "apply_patch verification failed: no such hunk"]),
        ]
        .flatMap { rollout.line($0).entries }
        XCTAssertEqual(entries.map(\.summary), ["/w/a.ts", nil])
        XCTAssertEqual(entries.last?.isError, true)
        XCTAssertEqual(ChangedFiles.list(entries).map(\.changes), [0])
        XCTAssertEqual(ChangedFiles.list(entries).map(\.lastFailed), [true])
    }

    func testThePatchFormatsAddsDeletesMovesAndHunks() {
        let patch = [
            "*** Begin Patch", "*** Add File: new.md", "+# New", "*** Update File: src/a.ts", "*** Move to: src/b.ts", "@@ function one",
            " keep", "-old", "+new", "@@", "-gone", "*** End of File", "*** Delete File: /abs/old.ts", "*** End Patch",
        ]
        .joined(separator: "\n")
        XCTAssertEqual(
            CodexTools.patchFiles(patch, cwd: "/w"),
            [
                CodexTools.PatchFile(tool: "Write", path: "/w/new.md", edits: []),
                CodexTools.PatchFile(
                    tool: "Edit", path: "/w/src/b.ts",
                    edits: [FileEdit(oldText: "keep\nold", newText: "keep\nnew"), FileEdit(oldText: "gone", newText: "")]),
                CodexTools.PatchFile(tool: "Edit", path: "/abs/old.ts", edits: []),
            ])
        XCTAssertEqual(CodexTools.patchFiles("not a patch", cwd: nil), [])
        XCTAssertEqual(CodexTools.absolute("../b/./c.ts", "/w/a"), "/w/b/c.ts")
    }

    func testShellOutputsAsEachOfCodexsShellToolsWritesThem() {
        func result(_ raw: String) -> [String] {
            let run = CodexRollout.execResult(raw)
            return [run.text, "\(run.isError)", run.session ?? "-"]
        }
        XCTAssertEqual(result("Exit code: 2\nWall time: 0.1 seconds\nOutput:\nboom\n"), ["Exit code 2\nboom\n", "true", "-"])
        XCTAssertEqual(result("Wall time: 1.0 seconds\nProcess exited with code 0\nOutput:\nok"), ["ok", "false", "-"])
        XCTAssertEqual(
            result("Chunk ID: a\nWall time: 1 seconds\nProcess running with session ID 3\nOutput:\npartial"),
            ["Command running in background\npartial", "false", "3"])
        XCTAssertEqual(result(#"{"output":"x","metadata":{"exit_code":1,"duration_seconds":0}}"#), ["Exit code 1\nx", "true", "-"])
        XCTAssertEqual(result("exec command rejected by user"), ["exec command rejected by user", "true", "-"])
        XCTAssertEqual(result("something else"), ["something else", "false", "-"])
    }

    func testCommandsAsAPersonTypesThem() {
        XCTAssertEqual(CodexTools.shellCommand(["cmd": "bun test"]), "bun test")
        XCTAssertEqual(CodexTools.shellCommand(["command": "ls -la"]), "ls -la")
        XCTAssertEqual(CodexTools.shellCommand(["command": ["bash", "-lc", "cd web && bun test"]]), "cd web && bun test")
        XCTAssertEqual(CodexTools.shellCommand(["command": ["/bin/zsh", "-c", "git push"]]), "git push")
        XCTAssertEqual(CodexTools.shellCommand(["command": ["powershell.exe", "-NoProfile", "-Command", "git status"]]), "git status")
        XCTAssertEqual(CodexTools.shellCommand(["command": ["git", "commit", "-m", "it's done"]]), #"git commit -m 'it'\''s done'"#)
        XCTAssertNil(CodexTools.shellCommand(["command": [1, 2]]))
        XCTAssertNil(CodexTools.shellCommand([:]))
    }

    func testCodexsToolNamesUnderClaudeCodesAsTheAgentHasThem() throws {
        struct Table: Decodable {
            struct Case: Decodable {
                let tool: String
                let namespace: String?
                let name: String
            }
            let cases: [Case]
        }
        let url = Self.repository.appendingPathComponent("shared/test/codex-tool-names.json")
        let table = try JSONDecoder().decode(Table.self, from: Data(contentsOf: url))
        XCTAssertGreaterThan(table.cases.count, 10)
        for item in table.cases {
            XCTAssertEqual(CodexTools.name(item.tool, namespace: item.namespace), item.name, "\(item.tool) \(item.namespace ?? "")")
        }
    }

    func testThreadNamesFromCodexsIndexTheNewestWinning() {
        let index = [
            #"{"id":"t1","thread_name":"First name","updated_at":"2026-11-04T10:00:00Z"}"#, "not json",
            #"{"id":"t2","thread_name":"  "}"#, #"{"id":"t1","thread_name":" Fix the build "}"#,
        ]
        XCTAssertEqual(CodexRollout.threadNames(index.joined(separator: "\n")), ["t1": "Fix the build"])
    }

    /// The agent reports a Codex session under its rollout's `session_id`: the Mac reads the same id from the rollout, so
    /// when both have the session, the agent's copy, which can chat, is the one shown.
    func testTheAgentsCopyOfACodexSessionWinsOverTheOneReadHere() throws {
        let session = try XCTUnwrap(CodexRollout.session(try fixture()[0]))
        func summary(_ id: String, canChat: Bool) -> SessionSummary {
            SessionSummary(
                id: id, machineId: canChat ? "m1" : "this-mac", machine: "Mac", platform: "darwin", cwd: "/work/hero", project: "hero",
                title: nil, status: .idle, statusText: nil, agentOnline: true, canChat: canChat, pendingPermissions: [], costUSD: nil,
                startedAt: Date(), lastActivity: Date(), lastMessage: nil, tool: "codex")
        }
        let agent = summary("01a2b3c4-5d6e-7f80-91a2-b3c4d5e6f708", canChat: true)
        let here = summary(session.sessionId, canChat: false)
        let other = summary("other", canChat: false)
        XCTAssertEqual(SessionSummary.merged(relay: [agent], local: [here, other]).map(\.canChat), [true, false])
        XCTAssertEqual(SessionSummary.merged(relay: [], local: [here, other], dismissed: ["other"]).map(\.id), [session.sessionId])
        // A subagent's rollout names its parent's session: it is no session of its own to show.
        let subagent = try line("session_meta", ["id": "t2", "session_id": session.sessionId, "cwd": "/w", "source": ["subagent": [:]]])
        XCTAssertEqual(CodexRollout.session(subagent)?.subagent, true)
    }
}
