import SwiftUI
import TontonCore
import WidgetKit

/// The widget extension. SwiftPM only builds this executable: scripts/build-app.sh wraps it into
/// Contents/PlugIns/TontonWidget.appex, sandboxed, with the app group it shares with the app.
@main
struct TontonWidgets: WidgetBundle {
    var body: some Widget {
        SessionsWidget()
    }
}

/// The status of every session, on the desktop or in Notification Center.
struct SessionsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: WidgetSnapshot.kind, provider: SessionsProvider()) { entry in
            SessionsEntryView(entry: entry)
        }
        .configurationDisplayName("Claude sessions")
        .description("What Claude is doing on each of your machines.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct SessionsEntry: TimelineEntry {
    let date: Date
    /// Nil until the app has written one, or when the widget can't read it.
    let snapshot: WidgetSnapshot?
}

/// Reads what the app wrote. The app reloads the widget whenever that changes.
struct SessionsProvider: TimelineProvider {
    func placeholder(in context: Context) -> SessionsEntry {
        SessionsEntry(date: Date(), snapshot: .sample)
    }

    func getSnapshot(in context: Context, completion: @escaping (SessionsEntry) -> Void) {
        completion(SessionsEntry(date: Date(), snapshot: context.isPreview ? .sample : Self.read()))
    }

    // Reads the file again every quarter of an hour too, in case macOS dropped a reload the app asked for.
    func getTimeline(in context: Context, completion: @escaping (Timeline<SessionsEntry>) -> Void) {
        let entry = SessionsEntry(date: Date(), snapshot: Self.read())
        completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(15 * 60))))
    }

    private static func read() -> WidgetSnapshot? {
        WidgetShare(bundle: .main)?.load()
    }
}

struct SessionsEntryView: View {
    @Environment(\.widgetFamily) private var family
    let entry: SessionsEntry

    var body: some View {
        SessionsView(snapshot: entry.snapshot, family: family)
            .containerBackground(.fill.tertiary, for: .widget)
            // Outside the rows: the session that needs the user, else the notch.
            .widgetURL(entry.snapshot?.sessions.first { $0.status.needsAttention }?.link ?? URL(string: "tonton://open"))
    }
}
