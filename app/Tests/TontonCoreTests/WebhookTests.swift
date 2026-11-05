import XCTest

@testable import TontonCore

final class WebhookTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_793_800_000)
    private let reply = """
        Built the menu and published it: [Main menu mockup](https://claude.ai/artifact/3f2a9c), see also \
        https://claude.ai/code/artifact/7b1e-44. The fix is in https://github.com/me/game/pull/42.
        Unrelated: https://example.com/page \u{2014} and the same artifact again https://claude.ai/artifact/3f2a9c.
        """

    private func session(status: SessionStatus = .idle, name: String? = nil, permission: Bool = false) -> SessionSummary {
        SessionSummary(
            id: "s", machineId: "m", machine: "DELPC", platform: nil, cwd: "/", project: "ChaoticBaton", title: nil, status: status,
            statusText: nil, agentOnline: true, canChat: true,
            pendingPermissions: permission
                ? [PermissionRequest(requestId: "r", toolName: "Bash", description: "", inputPreview: "rm -rf build", ts: "")] : [],
            costUSD: 96.77, startedAt: now, lastActivity: now, lastMessage: "Deploying with the secret key", model: "claude-opus-4-5",
            branch: "main", tasks: TaskProgress(done: 3, total: 5), turns: [Turn(end: now.addingTimeInterval(-3), seconds: 4_380)],
            name: name)
    }

    private func json(_ url: String, _ post: Webhook.Post) throws -> [String: Any] {
        let body = Webhook.body(for: try XCTUnwrap(URL(string: url)), post: post)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    }

    func testNothingAboutTheSessionByDefault() {
        let post = Webhook.post(.finished, session(), privacy: .init(), reply: reply, now: now)
        XCTAssertEqual(post.title, "A session finished")
        XCTAssertEqual(post.author, "Claude Code")
        XCTAssertNil(post.excerpt)
        XCTAssertEqual(post.links, [])
        XCTAssertEqual(post.fields.map(\.name), ["Model", "Worked", "Tasks", "Session cost"])
        XCTAssertEqual(post.fields.map(\.value), ["Opus 4.5", "1 h 13 min", "3 of 5 done", "$96.77"])
        for secret in ["ChaoticBaton", "DELPC", "main", "secret", "claude.ai"] { XCTAssertFalse(post.text.contains(secret), secret) }
    }

    func testNamesAndTheAnswerOnlyWhenAllowed() {
        let named = Webhook.post(.finished, session(), privacy: .init(includeNames: true), now: now)
        XCTAssertEqual(named.title, "ChaoticBaton finished")
        XCTAssertEqual(named.author, "Claude Code on DELPC")
        XCTAssertEqual(named.fields.first, .init("Branch", "`main`"))
        let renamed = Webhook.post(.finished, session(name: "Loges"), privacy: .init(includeNames: true), now: now)
        XCTAssertEqual(renamed.title, "Loges finished")
        XCTAssertEqual(renamed.fields.first, .init("Project", "ChaoticBaton"))

        let answered = Webhook.post(.finished, session(), privacy: .init(includeLastMessage: true), reply: reply, now: now)
        XCTAssertEqual(answered.excerpt?.hasPrefix("Built the menu"), true)
        XCTAssertEqual(answered.excerpt?.contains("\u{2014}"), false)
        // Without the whole answer, the last message the agent sent.
        let short = Webhook.post(.finished, session(), privacy: .init(includeLastMessage: true), now: now)
        XCTAssertEqual(short.excerpt, "Deploying with the secret key")
    }

    func testTheArtifactsThenThePullRequestsOfTheAnswer() {
        let links = Webhook.post(.finished, session(), privacy: .init(includeLastMessage: true), reply: reply, now: now).links
        XCTAssertEqual(links.map(\.label), ["Main menu mockup", "Claude artifact", "Pull request #42"])
        XCTAssertEqual(
            links.map(\.url.absoluteString),
            ["https://claude.ai/artifact/3f2a9c", "https://claude.ai/code/artifact/7b1e-44", "https://github.com/me/game/pull/42"])
    }

    func testDiscordGetsAnEmbedWhoseTitleOpensTheArtifact() throws {
        let post = Webhook.post(.finished, session(), privacy: .init(includeNames: true, includeLastMessage: true), reply: reply, now: now)
        let body = try json("https://discord.com/api/webhooks/1/x", post)
        XCTAssertEqual(body["username"] as? String, "Tonton Claude")
        let embed = try XCTUnwrap((body["embeds"] as? [[String: Any]])?.first)
        XCTAssertEqual(embed["title"] as? String, "ChaoticBaton finished")
        XCTAssertEqual(embed["url"] as? String, "https://claude.ai/artifact/3f2a9c")
        XCTAssertEqual(embed["color"] as? Int, 0x3FB950)
        XCTAssertEqual((embed["author"] as? [String: Any])?["name"] as? String, "Claude Code on DELPC")
        let fields = try XCTUnwrap(embed["fields"] as? [[String: Any]])
        XCTAssertEqual(fields.last?["name"] as? String, "Links")
        XCTAssertEqual(
            fields.last?["value"] as? String,
            "[Main menu mockup](https://claude.ai/artifact/3f2a9c)\n[Claude artifact](https://claude.ai/code/artifact/7b1e-44)\n"
                + "[Pull request #42](https://github.com/me/game/pull/42)")
        XCTAssertNotNil(embed["timestamp"] as? String)
    }

    func testAnApprovalSaysWhatItAsksForOnlyWithTheAnswerAllowed() {
        let quiet = Webhook.post(.needsYou, session(status: .permission, permission: true), privacy: .init(), now: now)
        XCTAssertEqual(quiet.title, "A session needs you")
        XCTAssertEqual(quiet.color, 0xE3A008)
        XCTAssertEqual(quiet.fields.first?.name, "Status")
        XCTAssertFalse(quiet.fields.contains { $0.name == "Worked" || $0.name == "Asks to use" })
        let open = Webhook.post(
            .needsYou, session(status: .permission, permission: true), privacy: .init(includeLastMessage: true), now: now)
        XCTAssertEqual(open.fields.last, .init("Asks to use", "Bash\n```\nrm -rf build\n```", inline: false))
    }

    func testSlackGetsBlocksAndOtherServicesPlainText() throws {
        let post = Webhook.post(.finished, session(), privacy: .init(includeLastMessage: true), reply: "Use <b> & <i>", now: now)
        let slack = try json("https://hooks.slack.com/services/T/B/x", post)
        let blocks = try XCTUnwrap(slack["blocks"] as? [[String: Any]])
        XCTAssertEqual(blocks.map { $0["type"] as? String }, ["context", "header", "section", "section", "context"])
        XCTAssertEqual((blocks[2]["text"] as? [String: Any])?["text"] as? String, "> Use &lt;b&gt; &amp; &lt;i&gt;")
        XCTAssertNotNil(slack["text"] as? String)

        let other = try json("https://example.com/hook", post)
        XCTAssertEqual(other["text"] as? String, other["content"] as? String)
        XCTAssertEqual(
            other["text"] as? String,
            "Claude Code: A session finished\nModel: Opus 4.5 · Worked: 1 h 13 min · Tasks: 3 of 5 done · Session cost: $96.77\n"
                + "> Use <b> & <i>")
    }

    func testAnExcerptIsCutBetweenWordsAndClosesItsCode() throws {
        let cut = try XCTUnwrap(Webhook.excerpt(String(repeating: "word ", count: 200)))
        XCTAssertLessThanOrEqual(cut.count, 701)
        XCTAssertTrue(cut.hasSuffix("word…"))
        XCTAssertEqual(Webhook.excerpt("Run:\n```\nmake"), "Run:\n```\nmake\n```")
        XCTAssertNil(Webhook.excerpt("  \n "))
    }

    func testDurations() {
        XCTAssertEqual(Webhook.duration(45), "45 s")
        XCTAssertEqual(Webhook.duration(12 * 60 + 30), "12 min")
        XCTAssertEqual(Webhook.duration(65 * 60), "1 h 05 min")
    }

    func testOnlyHTTPS() {
        XCTAssertNotNil(Webhook.url(" https://discord.com/api/webhooks/1/x "))
        XCTAssertNil(Webhook.url("http://example.com/hook"))
        XCTAssertNil(Webhook.url("not a url"))
        XCTAssertNil(Webhook.url(""))
    }
}
