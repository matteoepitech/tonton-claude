import Foundation

/// A conversation saved to a file, as Markdown or as a styled HTML page that works offline. Images are embedded as
/// `data:` URLs, so the file stands on its own.
public enum ConversationExport {
    public enum Format: String, CaseIterable, Sendable {
        case markdown, html

        public var fileExtension: String { self == .markdown ? "md" : "html" }
    }

    public static func render(_ format: Format, title: String, subtitle: String, entries: [Entry]) -> String {
        format == .markdown
            ? markdown(title: title, subtitle: subtitle, entries: entries) : html(title: title, subtitle: subtitle, entries: entries)
    }

    // MARK: Markdown

    static func markdown(title: String, subtitle: String, entries: [Entry]) -> String {
        var md = "# \(title)\n\n_\(subtitle)_\n\n"
        for item in ChatItem.build(from: entries) {
            switch item {
            case .user(let entry):
                md += String(core: "**You:** \(entry.text ?? "")") + "\n\n"
                md += images(entry.images) { "![image](\($0))\n\n" }
            case .assistant(let entry):
                md += "\(entry.text ?? "")\n\n"
            case .tool(let call, let result):
                let failed = result?.isError == true ? " " + String(core: "(failed)") : ""
                md += "- `\(call.name ?? "tool")` \(call.summary ?? "")\(failed)\n\n"
                md += images(result?.images) { "  ![tool result](\($0))\n\n" }
            case .system(let entry):
                md += "> \(entry.text ?? "")\n\n"
            }
        }
        return md
    }

    // MARK: HTML

    static func html(title: String, subtitle: String, entries: [Entry]) -> String {
        var body = ""
        for item in ChatItem.build(from: entries) {
            switch item {
            case .user(let entry):
                body += "<div class=\"user\">\(escape(entry.text ?? "").replacingOccurrences(of: "\n", with: "<br>"))"
                body += images(entry.images) { "<img src=\"\($0)\" alt=\"\">" }
                body += "</div>\n"
            case .assistant(let entry):
                body += "<div class=\"assistant\">\(markdownHTML(entry.text ?? ""))</div>\n"
            case .tool(let call, let result):
                let failed = result?.isError == true ? " failed" : ""
                body +=
                    "<details class=\"tool\(failed)\"><summary><b>\(escape(call.name ?? "tool"))</b> \(escape(call.summary ?? ""))</summary>"
                if let text = result?.text, !text.isEmpty { body += "<pre>\(escape(text))</pre>" }
                body += images(result?.images) { "<img src=\"\($0)\" alt=\"\">" }
                body += "</details>\n"
            case .system(let entry):
                body += "<p class=\"system\">\(escape(entry.text ?? ""))</p>\n"
            }
        }
        return """
            <!doctype html>
            <html lang="en">
            <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>\(escape(title))</title>
            <style>
            :root { --bg: #ffffff; --text: #16171a; --dim: #6b6f76; --raised: #f3f4f6; --border: #e3e5e8; --accent: #5e6ad2; }
            @media (prefers-color-scheme: dark) {
              :root { --bg: #0a0a0b; --text: #f7f8f8; --dim: #8a8f98; --raised: #17181b; --border: #26272b; --accent: #7170ff; }
            }
            body { background: var(--bg); color: var(--text); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                   max-width: 760px; margin: 40px auto; padding: 0 16px; }
            h1 { font-size: 22px; margin: 0 0 4px; }
            .subtitle { color: var(--dim); margin: 0 0 28px; font-size: 13px; }
            .user { background: var(--accent); color: #fff; border-radius: 14px; padding: 9px 13px; margin: 14px 0 14px auto;
                    width: fit-content; max-width: 80%; }
            .assistant { margin: 14px 0; }
            .tool { background: var(--raised); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; margin: 8px 0;
                    font-size: 13px; }
            .tool summary { cursor: pointer; color: var(--dim); }
            .tool summary b { color: var(--text); }
            .tool.failed summary b { color: #eb5757; }
            .system { color: var(--dim); text-align: center; font-size: 12px; }
            pre, code { font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
            pre { background: var(--raised); border: 1px solid var(--border); border-radius: 8px; padding: 10px; overflow-x: auto; }
            :not(pre) > code { background: var(--raised); border-radius: 4px; padding: 1px 4px; }
            table { border-collapse: collapse; margin: 10px 0; font-size: 13.5px; }
            th, td { border-bottom: 1px solid var(--border); padding: 5px 10px; }
            th { text-align: left; }
            img { max-width: 100%; border-radius: 8px; margin-top: 8px; display: block; }
            a { color: var(--accent); }
            </style>
            </head>
            <body>
            <h1>\(escape(title))</h1>
            <p class="subtitle">\(escape(subtitle))</p>
            \(body)</body>
            </html>

            """
    }

    /// Code blocks, tables and the inline styles Claude uses: bold, italics, code and links.
    static func markdownHTML(_ text: String) -> String {
        MarkdownBlock.parse(text).map { block in
            switch block {
            case .prose(let prose):
                return prose.components(separatedBy: "\n\n").map { "<p>\(inline($0).replacingOccurrences(of: "\n", with: "<br>"))</p>" }
                    .joined()
            case .code(let code):
                return "<pre><code>\(escape(code))</code></pre>"
            case .table(let table):
                let align = table.alignments.map { alignment in
                    switch alignment {
                    case .leading: ""
                    case .center: " style=\"text-align:center\""
                    case .trailing: " style=\"text-align:right\""
                    }
                }
                let header = table.header.enumerated().map { "<th\(align[$0.offset])>\(inline($0.element))</th>" }.joined()
                let rows = table.rows.map { row in
                    "<tr>" + row.enumerated().map { "<td\(align[$0.offset])>\(inline($0.element))</td>" }.joined() + "</tr>"
                }
                return "<table><tr>\(header)</tr>\(rows.joined())</table>"
            }
        }
        .joined(separator: "\n")
    }

    static func inline(_ text: String) -> String {
        var html = escape(text)
        html = html.replacing(#/`([^`]+)`/#) { "<code>\($0.1)</code>" }
        html = html.replacing(#/\*\*([^*]+)\*\*/#) { "<strong>\($0.1)</strong>" }
        html = html.replacing(#/(^|[^*\w])\*([^*\s][^*]*)\*(?![*\w])/#) { "\($0.1)<em>\($0.2)</em>" }
        html = html.replacing(#/\[([^\]]+)\]\((https?://[^)\s]+)\)/#) { "<a href=\"\($0.2)\">\($0.1)</a>" }
        return html
    }

    static func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    }

    private static func images(_ images: [ImageData]?, _ tag: (String) -> String) -> String {
        (images ?? []).map { tag("data:\($0.mediaType);base64,\($0.data)") }.joined()
    }
}
