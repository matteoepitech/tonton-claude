import SwiftUI
import TontonCore
import WidgetKit

/// The widget's content for each size. The family comes as a value so the views can be rendered outside WidgetKit.
struct SessionsView: View {
    let snapshot: WidgetSnapshot?
    let family: WidgetFamily

    var body: some View {
        if let snapshot, snapshot.running {
            if family == .systemSmall {
                SmallSessions(snapshot: snapshot)
            } else {
                SessionList(snapshot: snapshot, rows: family == .systemLarge ? 9 : 3)
            }
        } else {
            // Nil: the app never wrote, or this build has no group to share (see build-app.sh).
            WidgetMessage(text: snapshot == nil ? "Open Tonton Claude to see your sessions here." : "Tonton Claude isn't running.")
        }
    }
}

/// The count that matters most, big, and the first sessions.
private struct SmallSessions: View {
    let snapshot: WidgetSnapshot

    var body: some View {
        let headline = Headline(snapshot)
        VStack(alignment: .leading, spacing: 0) {
            WidgetTitle()
            Spacer(minLength: 4)
            if let count = headline.count {
                Text("\(count)").font(.system(size: 34, weight: .semibold, design: .rounded)).foregroundStyle(headline.color)
            }
            Text(headline.text).font(.system(size: 12, weight: .medium)).lineLimit(1)
            Spacer(minLength: 6)
            VStack(alignment: .leading, spacing: 3) {
                ForEach(snapshot.sessions.prefix(2)) { session in
                    HStack(spacing: 5) {
                        StatusDot(status: session.status)
                        Text(session.project).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

/// The counts, then one row per session, the ones that need the user first. A row opens the notch on its session.
private struct SessionList: View {
    let snapshot: WidgetSnapshot
    let rows: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                WidgetTitle()
                Spacer(minLength: 4)
                Counts(snapshot: snapshot)
            }
            if snapshot.sessions.isEmpty {
                Spacer(minLength: 0)
                Text("No sessions right now.").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            ForEach(snapshot.sessions.prefix(rows)) { session in
                if let link = session.link {
                    Link(destination: link) { SessionRow(session: session) }
                } else {
                    SessionRow(session: session)
                }
            }
            if snapshot.sessions.count > rows {
                Text("\(snapshot.sessions.count - rows) more in the notch").font(.system(size: 10)).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct SessionRow: View {
    let session: WidgetSnapshot.Session

    var body: some View {
        HStack(spacing: 8) {
            StatusDot(status: session.status)
            VStack(alignment: .leading, spacing: 1) {
                Text(session.project).font(.system(size: 12.5, weight: .semibold)).lineLimit(1)
                Text(session.machine).font(.system(size: 10.5)).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 1) {
                Text(session.status.label).font(.system(size: 10.5, weight: .medium)).lineLimit(1)
                // Moves by itself, without a reload. Date styles take all the width they may need: the frame bounds it.
                Text(session.since, style: .relative).font(.system(size: 10)).foregroundStyle(.secondary).monospacedDigit()
                    .multilineTextAlignment(.trailing).lineLimit(1)
            }
            .frame(width: 104, alignment: .trailing)
        }
    }
}

private struct Counts: View {
    let snapshot: WidgetSnapshot

    var body: some View {
        HStack(spacing: 8) {
            if snapshot.needYou > 0 { count(snapshot.needYou, snapshot.needYou == 1 ? "needs you" : "need you", .orange) }
            if snapshot.working > 0 { count(snapshot.working, "working", .green) }
            if snapshot.needYou == 0 && snapshot.working == 0 && snapshot.done > 0 { count(snapshot.done, "done", .blue) }
        }
    }

    private func count(_ value: Int, _ label: String, _ color: Color) -> some View {
        Text("\(value) \(label)").font(.system(size: 11, weight: .semibold)).foregroundStyle(color).lineLimit(1)
    }
}

/// What the small widget puts first: the sessions that need the user, else the ones at work, else the finished ones.
private struct Headline {
    let count: Int?
    let text: String
    let color: Color

    init(_ snapshot: WidgetSnapshot) {
        if snapshot.needYou > 0 {
            (count, text, color) = (snapshot.needYou, snapshot.needYou == 1 ? "needs you" : "need you", .orange)
        } else if snapshot.working > 0 {
            (count, text, color) = (snapshot.working, "working", .green)
        } else if snapshot.done > 0 {
            (count, text, color) = (snapshot.done, "done", .blue)
        } else {
            (count, text, color) = (nil, "No sessions", .secondary)
        }
    }
}

private struct WidgetTitle: View {
    var body: some View {
        Text("Claude").font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
    }
}

private struct WidgetMessage: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            WidgetTitle()
            Spacer(minLength: 6)
            Text(text).font(.system(size: 13, weight: .medium)).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

/// The notch's colors for each state.
struct StatusDot: View {
    let status: SessionStatus

    var body: some View {
        Circle().fill(color).frame(width: 7, height: 7)
    }

    private var color: Color {
        switch status {
        case .working, .starting: .green
        case .waiting: .yellow
        case .permission: .orange
        case .idle: .blue
        case .error: .red
        case .ended, .offline: .gray
        }
    }
}

extension WidgetSnapshot {
    /// For the widget gallery, before the app has written anything.
    static var sample: WidgetSnapshot {
        let now = Date()
        let sessions = [
            Session(id: "1", project: "api", machine: "Studio", status: .permission, since: now.addingTimeInterval(-90)),
            Session(id: "2", project: "web", machine: "MacBook Pro", status: .working, since: now.addingTimeInterval(-720)),
            Session(id: "3", project: "infra", machine: "build-box", status: .working, since: now.addingTimeInterval(-300)),
            Session(id: "4", project: "docs", machine: "MacBook Pro", status: .idle, since: now.addingTimeInterval(-2400)),
        ]
        return WidgetSnapshot(running: true, sessions: sessions, needYou: 1, working: 2, done: 1)
    }
}
