import SwiftUI
import TontonCore

/// The hero screen, in the notch's right column: Tonton's card on top, then one page at a time behind a row of icons.
/// The arena opens its own window.
struct HeroScreen: View {
    @ObservedObject private var rpg = RPGStore.shared
    @EnvironmentObject var store: SessionStore
    @EnvironmentObject var state: NotchState

    var body: some View {
        let live = store.visibleSessions.filter(\.status.isLive).map(\.status)
        HeroScreenContent(
            hero: rpg.hero, ready: rpg.ready, busy: rpg.busy, error: rpg.error,
            pose: SessionStatus.mostUrgent(live).map(HeroArt.Pose.init) ?? .resting, page: $state.heroPage, preview: $state.heroPreview,
            equip: rpg.equip, arena: rpg.startArena)
    }
}

enum HeroPage: CaseIterable {
    case journal, wardrobe, boosters, upgrades, team

    var symbol: String {
        switch self {
        case .journal: "list.bullet.rectangle"
        case .wardrobe: "tshirt"
        case .boosters: "shippingbox"
        case .upgrades: "arrow.up.circle"
        case .team: "person.3"
        }
    }

    var label: String {
        switch self {
        case .journal: String(localized: "Journal")
        case .wardrobe: String(localized: "Wardrobe")
        case .boosters: String(localized: "Boosters")
        case .upgrades: String(localized: "Upgrades")
        case .team: String(localized: "Team")
        }
    }
}

/// Pure presentation, also used by the image renderer: no account, store or network.
struct HeroScreenContent: View {
    let hero: RPG.State
    var ready = true
    var busy = false
    var error: String?
    let pose: HeroArt.Pose
    @Binding var page: HeroPage
    @Binding var preview: RPG.Item?
    var equip: (RPG.Item?, RPG.Slot) -> Void = { _, _ in }
    var arena: () -> Void = {}
    /// Fixed in the renderer's images; the clock otherwise.
    var now: Date?

    var body: some View {
        TimelineView(.everyMinute) { context in
            let now = now ?? context.date
            VStack(alignment: .leading, spacing: 12) {
                let today = hero.today(now: now)
                HeroCard(hero: HeroWardrobe.wearing(preview, hero), pose: pose, day: day(today, now: now), hour: today.hour(of: now))
                    .padding(.top, 4)
                if let error { Text(error).font(.notch(11)).foregroundStyle(Theme.warning) }
                tabs
                pageView(now)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
        .onChange(of: page) { _, _ in preview = nil }
    }

    private func day(_ today: RPG.Today, now: Date) -> HeroDay {
        HeroDay(xp: today.xp, streak: today.streak, hours: today.hours, start: today.start, counted: hero.playedToday(now: now))
    }

    private var tabs: some View {
        HStack(spacing: 2) {
            ForEach(HeroPage.allCases, id: \.self) { item in
                Button {
                    page = item
                } label: {
                    Image(systemName: page == item ? "\(item.symbol).fill" : item.symbol)
                        .font(.notch(13, weight: .medium))
                        .frame(width: 34, height: 28)
                        .background(RoundedRectangle(cornerRadius: 8).fill(page == item ? Theme.accent.opacity(0.18) : .clear))
                        .overlay(alignment: .topTrailing) {
                            if item == .boosters && !hero.boosters.isEmpty {
                                Text("\(hero.boosters.count)")
                                    .font(.system(size: 9, weight: .bold, design: .rounded))
                                    .foregroundStyle(Theme.onAccent)
                                    .padding(.horizontal, 4)
                                    .background(Capsule().fill(Theme.accent))
                                    .offset(x: 2, y: -2)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(page == item ? Theme.accent : Theme.ink.opacity(0.65))
                .help(item.label)
                .accessibilityLabel(item.label)
                .accessibilityValue(item == .boosters ? Text("\(hero.boosters.count) to open") : Text(verbatim: ""))
                .accessibilityAddTraits(page == item ? .isSelected : [])
            }
            Spacer(minLength: 8)
            Button(action: arena) {
                Label("Play arena", systemImage: "gamecontroller.fill").font(.notch(11, weight: .semibold))
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 10)
            .frame(height: 26)
            .background(Capsule().fill(Theme.raised))
            .disabled(!ready)
            .help("Tonton's arena opens in its own window")
        }
    }

    @ViewBuilder private func pageView(_ now: Date) -> some View {
        switch page {
        case .journal:
            ScrollView { HeroJournal(entries: hero.journal(limit: 30), now: now).padding(.bottom, 8) }
        case .wardrobe:
            ScrollView { HeroWardrobe(hero: hero, preview: $preview, enabled: ready && !busy, equip: equip).padding(.bottom, 8) }
        case .boosters: HeroBoosters()
        case .upgrades: RPGUpgradesView()
        case .team: RPGPoolView()
        }
    }
}

/// The last gains and why: "+18 · 13 minutes of work in tonton-claude", newest first.
struct HeroJournal: View {
    let entries: [RPG.JournalEntry]
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if entries.isEmpty {
                Text("Finish a turn with Claude Code, OpenCode or Codex and Tonton earns his first XP.")
                    .font(.notch(12))
                    .foregroundStyle(Theme.secondary)
                    .padding(.vertical, 8)
            }
            ForEach(entries) { entry in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("+\(entry.xp)")
                        .font(.system(size: Theme.textSize.points(12), weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(Theme.success)
                        .frame(minWidth: 30, alignment: .trailing)
                    Text(entry.reason).font(.notch(12)).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 6)
                    if let date = entry.date {
                        Text(Self.when(date, at: entry.at != nil, now: now))
                            .font(.notch(10))
                            .monospacedDigit()
                            .foregroundStyle(Theme.tertiary)
                    }
                }
                .padding(.vertical, 5)
                .overlay(alignment: .bottom) { Rectangle().fill(Theme.line(0.06)).frame(height: 1) }
                .accessibilityElement(children: .combine)
            }
        }
    }

    /// The time for today's gains, the day for older ones.
    static func when(_ date: Date, at time: Bool, now: Date) -> String {
        if time && Calendar.current.isDate(date, inSameDayAs: now) { return date.formatted(date: .omitted, time: .shortened) }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}
