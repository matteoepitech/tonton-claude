import SwiftUI
import TontonCore

// The hero screen's Boosters page (#356, #358): the boosters to open, each saying where it comes from, Open all, and
// the drops so far as tiles in their rarity's colours, like the wardrobe's. A drop is revealed over the page, so it
// shows wherever the list is scrolled, and stays until Done. Openings show a committed receipt: closing, skipping or
// reconnecting never changes a drop.

/// The page, on the store.
struct HeroBoosters: View {
    @ObservedObject private var rpg = RPGStore.shared

    var body: some View {
        HeroBoostersContent(
            hero: rpg.hero, ready: rpg.ready, busy: rpg.busy, reveal: rpg.reveal, open: rpg.openBooster, openAll: rpg.openAll,
            show: rpg.showOpening, uncover: rpg.uncoverReveal, dismiss: rpg.dismissReveal, equip: rpg.equip)
    }
}

/// Pure presentation, also used by the image renderer: no account, store or network.
struct HeroBoostersContent: View {
    let hero: RPG.State
    var ready = true
    var busy = false
    var reveal: BoosterReveal?
    var open: (String) -> Void = { _ in }
    var openAll: () -> Void = {}
    var show: (String) -> Void = { _ in }
    var uncover: () -> Void = {}
    var dismiss: () -> Void = {}
    var equip: (RPG.Item?, RPG.Slot) -> Void = { _, _ in }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                header
                if hero.boosters.isEmpty { empty } else { boosters }
                if !hero.openings.isEmpty { openings }
            }
            .padding(.bottom, 8)
        }
        .scrollIndicators(.never)
        .overlay {
            if let reveal {
                BoosterRevealView(reveal: reveal, hero: hero, busy: busy, uncover: uncover, dismiss: dismiss, equip: equip)
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.2), value: reveal?.boosters)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text("Boosters").font(.notch(13, weight: .bold)).accessibilityAddTraits(.isHeader)
                if !hero.boosters.isEmpty { PoolChip(text: "\(hero.boosters.count)", systemImage: "shippingbox.fill") }
                Spacer(minLength: 6)
                if hero.boosters.count > 1 {
                    Button(action: openAll) { Label("Open all", systemImage: "sparkles") }
                        .buttonStyle(NotchButtonStyle(kind: .primary))
                        .disabled(!ready || busy)
                        .help("Opens every booster at once")
                }
            }
            Text("One cosmetic per booster: common 60%, uncommon 25%, rare 10%, epic 4%, legendary 1%. A duplicate turns into sparks.")
                .font(.notch(10.5))
                .foregroundStyle(Theme.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var empty: some View {
        HStack(spacing: 10) {
            IconTile(systemName: "shippingbox", tint: Theme.accent, size: 30).accessibilityHidden(true)
            Text("No booster to open. Levels, bosses, achievements and team goals earn them.")
                .font(.notch(11))
                .foregroundStyle(Theme.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .poolCard(padding: 10)
    }

    private var boosters: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 94), spacing: 8)], spacing: 8) {
            ForEach(hero.boosters, id: \.self) { id in booster(id) }
        }
    }

    private func booster(_ id: String) -> some View {
        let source = RPG.BoosterSource(id)
        return VStack(spacing: 7) {
            Image(systemName: "shippingbox.fill")
                .font(.system(size: 26))
                .foregroundStyle(Theme.accentGradient)
                .overlay(alignment: .bottomTrailing) {
                    Image(systemName: source.symbol)
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(Theme.onAccent)
                        .padding(3)
                        .background(Circle().fill(Theme.accentDeep))
                        .overlay(Circle().stroke(Theme.surface, lineWidth: 1.5))
                        .offset(x: 7, y: 4)
                }
                .frame(height: 32)
                .accessibilityHidden(true)
            Text(verbatim: source.label).font(.notch(10.5, weight: .semibold)).lineLimit(1)
            Button("Open") { open(id) }
                .buttonStyle(NotchButtonStyle(kind: .primary))
                .disabled(!ready || busy)
                .accessibilityLabel(Text("Open the booster of \(source.label)"))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .padding(.horizontal, 6)
        .poolCard(highlighted: true, padding: 0)
    }

    private var openings: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("Opened").font(.notch(11, weight: .semibold)).foregroundStyle(Theme.secondary)
                Text(verbatim: "\(hero.openings.count)").font(.notch(10.5)).monospacedDigit().foregroundStyle(Theme.tertiary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 50), spacing: 6)], spacing: 6) {
                ForEach(RPG.openingOrder(hero.openings.keys), id: \.self) { id in
                    if let opening = hero.openings[id], let item = RPG.catalog.first(where: { $0.id == opening.item }) {
                        Button {
                            show(id)
                        } label: {
                            BoosterDropTile(item: item, hero: hero)
                        }
                        .buttonStyle(.plain)
                        .help(Text(verbatim: "\(RPG.BoosterSource(id).label) · \(item.rarity.label) · \(item.slot.label)"))
                        .accessibilityLabel(Text(verbatim: "\(RPG.BoosterSource(id).label) · \(item.rarity.label) · \(item.slot.label)"))
                    }
                }
            }
        }
    }
}

/// A drop: Tonton wearing it, framed in its rarity's colour and weight, as in the wardrobe.
struct BoosterDropTile: View {
    let item: RPG.Item
    let hero: RPG.State
    var size: CGFloat = 50

    var body: some View {
        let tier = CGFloat(RPG.Rarity.allCases.firstIndex(of: item.rarity) ?? 0)
        HeroSprite(hero: HeroWardrobe.wearing(item, hero), pose: .idle, size: size * 0.8, animated: false)
            .frame(width: size, height: size)
            .background(RoundedRectangle(cornerRadius: 9).fill(Color(hex: item.color).opacity(tier >= 3 ? 0.14 : 0.06)))
            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Color(hex: item.color), lineWidth: 1 + tier * 0.4))
            .contentShape(RoundedRectangle(cornerRadius: 9))
    }
}

/// Over the page: the boosters for a moment, then what they gave, until Done. One drop gets the big Tonton and Equip;
/// several, a tile each.
struct BoosterRevealView: View {
    let reveal: BoosterReveal
    let hero: RPG.State
    var busy = false
    var uncover: () -> Void = {}
    var dismiss: () -> Void = {}
    var equip: (RPG.Item?, RPG.Slot) -> Void = { _, _ in }
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var burst = false
    @State private var shake = false

    private struct Drop {
        let booster: String
        let item: RPG.Item
        let opening: RPG.Opening
    }

    private var drops: [Drop] {
        reveal.boosters.compactMap { id in
            guard let opening = hero.openings[id], let item = RPG.catalog.first(where: { $0.id == opening.item }) else { return nil }
            return Drop(booster: id, item: item, opening: opening)
        }
    }

    var body: some View {
        let drops = drops
        let best = drops.max { tier($0.item) < tier($1.item) }?.item
        let tint = reveal.uncovered ? best.map { Color(hex: $0.color) } ?? Theme.accent : Theme.accent
        ZStack {
            // Swallows clicks: the page under it waits for Done.
            Rectangle().fill(Theme.bg.opacity(0.88)).contentShape(Rectangle()).onTapGesture {}.accessibilityHidden(true)
            VStack(spacing: 10) {
                if !reveal.uncovered {
                    covered
                } else if drops.count == 1, let drop = drops.first {
                    single(drop)
                } else {
                    several(drops)
                }
            }
            .padding(14)
            .frame(maxWidth: 340)
            .background(RoundedRectangle(cornerRadius: 16).fill(Theme.surface))
            .background(RoundedRectangle(cornerRadius: 16).fill(tint.opacity(reveal.uncovered ? 0.14 : 0.06)).padding(-1))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(tint.opacity(0.8), lineWidth: 1 + CGFloat(best.map(tier) ?? 0) * 0.5))
            .padding(10)
        }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .task(id: reveal.boosters) {
            guard !reveal.uncovered else { return }
            if reduceMotion { return uncover() }
            shake = true
            try? await Task.sleep(for: .seconds(1.2))
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.4)) { uncover() }
            withAnimation(.easeOut(duration: 0.5)) { burst = true }
            try? await Task.sleep(for: .seconds(0.8))
            withAnimation(.easeOut(duration: 0.4)) { burst = false }
        }
    }

    private var covered: some View {
        VStack(spacing: 10) {
            Image(systemName: "shippingbox.fill")
                .font(.system(size: 54))
                .foregroundStyle(Theme.accentGradient)
                .rotationEffect(.degrees(shake && !reduceMotion ? 6 : -6))
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.12).repeatForever(autoreverses: true), value: shake)
                .accessibilityHidden(true)
            Text(reveal.boosters.count > 1 ? "Opening \(reveal.boosters.count) boosters…" : "Opening the booster…")
                .font(.notch(12, weight: .semibold))
            Button("Skip", action: uncover).buttonStyle(NotchButtonStyle())
        }
        .frame(minHeight: 150)
    }

    private func single(_ drop: Drop) -> some View {
        let worn = hero.item(drop.item.slot)?.id == drop.item.id
        return VStack(spacing: 8) {
            HeroSprite(hero: HeroWardrobe.wearing(drop.item, hero), pose: .cheer, size: 88)
                .background { if !reduceMotion { sparkles(drop.item) } }
            HStack(spacing: 6) {
                PoolChip(text: drop.item.rarity.label, tint: Color(hex: drop.item.color))
                Text(verbatim: drop.item.slot.label).font(.notch(12, weight: .bold))
            }
            .accessibilityElement(children: .combine)
            Text(verbatim: RPG.BoosterSource(drop.booster).label).font(.notch(10.5)).foregroundStyle(Theme.tertiary)
            if drop.opening.duplicateSparks > 0 {
                Text("Already yours: +\(drop.opening.duplicateSparks) sparks").font(.notch(11)).foregroundStyle(Theme.secondary)
            }
            HStack(spacing: 6) {
                if worn {
                    PoolChip(text: String(localized: "Wearing it"), systemImage: "checkmark", tint: Theme.success)
                } else {
                    Button("Equip") { equip(drop.item, drop.item.slot) }.buttonStyle(NotchButtonStyle(kind: .primary)).disabled(busy)
                }
                Button("Done", action: dismiss).buttonStyle(NotchButtonStyle()).keyboardShortcut(.defaultAction)
            }
            .padding(.top, 2)
        }
    }

    private func several(_ drops: [Drop]) -> some View {
        let sparks = drops.map(\.opening.duplicateSparks).reduce(0, +)
        let new = drops.filter { $0.opening.duplicateSparks == 0 }.count
        return VStack(spacing: 10) {
            Text("\(drops.count) boosters opened").font(.notch(13, weight: .bold))
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 50), spacing: 6)], spacing: 6) {
                    ForEach(drops, id: \.booster) { drop in
                        BoosterDropTile(item: drop.item, hero: hero)
                            .help(
                                Text(
                                    verbatim:
                                        "\(RPG.BoosterSource(drop.booster).label) · \(drop.item.rarity.label) · \(drop.item.slot.label)")
                            )
                            .accessibilityLabel(Text(verbatim: "\(drop.item.rarity.label) · \(drop.item.slot.label)"))
                    }
                }
            }
            .scrollIndicators(.never)
            .frame(maxHeight: 170)
            .fixedSize(horizontal: false, vertical: true)
            Text("\(new) new · +\(sparks) sparks from duplicates").font(.notch(11)).foregroundStyle(Theme.secondary)
            HStack(spacing: 6) {
                Text("Wear them from the wardrobe.").font(.notch(10.5)).foregroundStyle(Theme.tertiary)
                Spacer(minLength: 6)
                Button("Done", action: dismiss).buttonStyle(NotchButtonStyle(kind: .primary)).keyboardShortcut(.defaultAction)
            }
        }
    }

    /// Specks in the drop's colour flying out from behind Tonton: more of them the rarer it is.
    private func sparkles(_ item: RPG.Item) -> some View {
        ForEach(0..<(6 + tier(item) * 3), id: \.self) { index in
            Rectangle()
                .fill(Color(hex: item.color))
                .frame(width: 4, height: 4)
                .offset(x: cos(Double(index) * 2.4) * (burst ? 90 : 26), y: sin(Double(index) * 2.4) * (burst ? 60 : 20))
                .opacity(burst ? 1 : 0)
        }
    }

    private func tier(_ item: RPG.Item) -> Int { RPG.Rarity.allCases.firstIndex(of: item.rarity) ?? 0 }
}
