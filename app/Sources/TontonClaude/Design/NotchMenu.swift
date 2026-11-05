import SwiftUI
import TontonCore

// The notch's own dropdown: a list in the notch's colours under its button, instead of the system's menu, which looks
// out of place in the notch. The button hands its bounds up through NotchMenuAnchors; ExpandedView draws the open list
// over everything else, so no scroll view or card clips it. Escape, a click outside and the arrows work as in a menu.

/// One choice of a dropdown.
struct NotchMenuItem: Identifiable {
    let id = UUID()
    let title: String
    var detail: String?
    var systemImage: String?
    /// The current choice: a tick in front.
    var checked = false
    var destructive = false
    var enabled = true
    let action: () -> Void
}

/// Choices under an optional title, with an optional line of small print under them.
struct NotchMenuSection: Identifiable {
    let id = UUID()
    var title: String?
    var items: [NotchMenuItem]
    var note: String?
}

/// The dropdown open in the notch: the button it hangs from, what it lists, and the choice the keys are on.
struct NotchMenuRequest {
    let button: UUID
    let sections: [NotchMenuSection]
    let width: CGFloat
    var highlighted: UUID?

    var choices: [NotchMenuItem] { sections.flatMap(\.items).filter(\.enabled) }

    /// The arrows: the next choice, wrapping around.
    mutating func move(by step: Int) { highlighted = Dropdown.step(choices.map(\.id), from: highlighted, by: step) }

    var highlightedItem: NotchMenuItem? { choices.first { $0.id == highlighted } }
}

/// Where the open dropdown's button is, for ExpandedView to draw the list under it.
struct NotchMenuAnchors: PreferenceKey {
    static let defaultValue: [UUID: Anchor<CGRect>] = [:]

    static func reduce(value: inout [UUID: Anchor<CGRect>], nextValue: () -> [UUID: Anchor<CGRect>]) {
        value.merge(nextValue()) { $1 }
    }
}

/// A button that opens a dropdown. `sections` is read each time it opens, so the ticks are the current choices.
struct NotchMenu<Label: View>: View {
    var width: CGFloat = 220
    let sections: () -> [NotchMenuSection]
    @ViewBuilder let label: () -> Label
    @EnvironmentObject private var notch: NotchState
    @State private var id = UUID()

    var body: some View {
        let open = notch.menu?.button == id
        Button {
            notch.menu = open ? nil : NotchMenuRequest(button: id, sections: sections(), width: width)
        } label: {
            label().contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .anchorPreference(key: NotchMenuAnchors.self, value: .bounds) { open ? [id: $0] : [:] }
        .onDisappear { if notch.menu?.button == id { notch.menu = nil } }
        .accessibilityValue(open ? Text("Open") : Text(verbatim: ""))
    }
}

/// A dropdown's usual label: the current choice and a small chevron.
struct NotchMenuLabel: View {
    let text: String
    var size: CGFloat = 10

    var body: some View {
        HStack(spacing: 4) {
            Text(verbatim: text).font(.notch(size, weight: .semibold)).lineLimit(1)
            Image(systemName: "chevron.up.chevron.down").font(.notch(size - 2.5, weight: .bold)).foregroundStyle(Theme.tertiary)
        }
        .padding(.horizontal, 8)
        .frame(height: 22)
        .background(Capsule().fill(Theme.raised))
        .overlay(Capsule().stroke(Theme.border))
        .fixedSize()
    }
}

/// The open dropdown, over the whole expanded notch: a click outside the list closes it.
struct NotchMenuOverlay: View {
    let anchors: [UUID: Anchor<CGRect>]
    @EnvironmentObject private var notch: NotchState

    var body: some View {
        if let menu = notch.menu, let anchor = anchors[menu.button] {
            GeometryReader { proxy in
                ZStack(alignment: .topLeading) {
                    Color.black.opacity(0.001)
                        .contentShape(Rectangle())
                        .onTapGesture { notch.menu = nil }
                        .accessibilityHidden(true)
                    NotchMenuPlacement(button: proxy[anchor]) {
                        NotchMenuList(menu: menu)
                    }
                }
            }
            .transition(.opacity)
        }
    }
}

/// Under its button, or over it when there is more room above; aligned with its nearer edge and kept inside the notch.
struct NotchMenuPlacement: Layout {
    let button: CGRect

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let list = subviews.first else { return }
        let frame = Dropdown.frame(ideal: list.sizeThatFits(.unspecified), button: button, in: bounds.size)
        list.place(
            at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY), proposal: ProposedViewSize(frame.size))
    }
}

/// The list itself: sections split by a line, a tick or an icon in front of each choice, the hovered one lit.
struct NotchMenuList: View {
    let menu: NotchMenuRequest
    @EnvironmentObject private var notch: NotchState

    var body: some View {
        ViewThatFits(in: .vertical) {
            content
            ScrollView { content }.scrollIndicators(.never)
        }
        .frame(width: menu.width)
        .background(RoundedRectangle(cornerRadius: 11).fill(Theme.bg))
        .background(RoundedRectangle(cornerRadius: 11).fill(Theme.surface).padding(-0.5))
        .overlay(RoundedRectangle(cornerRadius: 11).stroke(Theme.borderStrong))
        .clipShape(RoundedRectangle(cornerRadius: 11))
        .shadow(color: .black.opacity(0.4), radius: 14, y: 6)
        .accessibilityElement(children: .contain)
    }

    private var content: some View {
        let icons = menu.sections.contains { $0.items.contains { $0.checked || $0.systemImage != nil } }
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(menu.sections.enumerated()), id: \.element.id) { index, section in
                if index > 0 { Rectangle().fill(Theme.line(0.08)).frame(height: 1).padding(.vertical, 4).padding(.horizontal, 4) }
                if let title = section.title {
                    Text(verbatim: title)
                        .font(.notch(9.5, weight: .semibold))
                        .foregroundStyle(Theme.tertiary)
                        .padding(.horizontal, 8)
                        .padding(.top, 3)
                        .padding(.bottom, 2)
                        .accessibilityAddTraits(.isHeader)
                }
                ForEach(section.items) { item in row(item, icons: icons) }
                if let note = section.note {
                    Text(verbatim: note)
                        .font(.notch(9.5))
                        .foregroundStyle(Theme.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                }
            }
        }
        .padding(5)
    }

    private func row(_ item: NotchMenuItem, icons: Bool) -> some View {
        let lit = menu.highlighted == item.id && item.enabled
        return Button {
            notch.menu = nil
            item.action()
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                if icons {
                    Image(systemName: item.checked ? "checkmark" : item.systemImage ?? "circle")
                        .font(.notch(10, weight: item.checked ? .bold : .medium))
                        .foregroundStyle(
                            item.checked && !item.destructive
                                ? AnyShapeStyle(Theme.accent) : lit ? AnyShapeStyle(Theme.text) : Theme.secondary
                        )
                        .opacity(item.checked || item.systemImage != nil ? 1 : 0)
                        .frame(width: 14)
                        .accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: item.title).font(.notch(11, weight: item.checked ? .semibold : .medium))
                        .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    if let detail = item.detail {
                        Text(verbatim: detail).font(.notch(9.5)).foregroundStyle(Theme.tertiary).fixedSize(
                            horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 7)
            .padding(.vertical, 5)
            .background(
                RoundedRectangle(cornerRadius: 7).fill(
                    lit ? (item.destructive ? Theme.danger.opacity(0.16) : Theme.accent.opacity(0.2)) : Color.clear)
            )
            .contentShape(RoundedRectangle(cornerRadius: 7))
        }
        .buttonStyle(.plain)
        .foregroundStyle(item.destructive ? Theme.danger : Theme.text)
        .disabled(!item.enabled)
        .opacity(item.enabled ? 1 : 0.4)
        .onHover { inside in
            if inside { notch.menu?.highlighted = item.id } else if notch.menu?.highlighted == item.id { notch.menu?.highlighted = nil }
        }
        .accessibilityAddTraits(item.checked ? .isSelected : [])
    }
}
