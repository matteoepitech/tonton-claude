import SwiftUI

/// Pop-up menu styled like the other controls.
struct ChoiceMenu: View {
    let selection: String
    let options: [(id: String, label: String)]
    let onSelect: (String) -> Void

    var body: some View {
        Menu {
            ForEach(options, id: \.id) { option in
                Button {
                    onSelect(option.id)
                } label: {
                    if option.id == selection { Label(option.label, systemImage: "checkmark") } else { Text(option.label) }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Text(options.first { $0.id == selection }?.label ?? selection).font(.system(size: 12.5, weight: .medium))
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.textDim)
            }
            .padding(.horizontal, 12)
            .frame(height: 30)
            .background(RoundedRectangle(cornerRadius: 7).fill(Theme.raised))
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(Theme.borderStrong))
            .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
    }
}

struct Segmented: View {
    let selection: String
    let options: [(id: String, label: String)]
    let onSelect: (String) -> Void

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.id) { option in
                Button {
                    onSelect(option.id)
                } label: {
                    Text(option.label)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(option.id == selection ? Theme.text : Theme.textDim)
                        .padding(.horizontal, 12)
                        .frame(height: 26)
                        .background(RoundedRectangle(cornerRadius: 6).fill(option.id == selection ? Theme.hover : .clear))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.code))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border))
    }
}

struct TimeField: View {
    @Binding var minutes: Int

    var body: some View {
        let date = Binding<Date>(
            get: { Calendar.current.date(bySettingHour: minutes / 60, minute: minutes % 60, second: 0, of: Date()) ?? Date() },
            set: { d in
                let c = Calendar.current.dateComponents([.hour, .minute], from: d)
                minutes = (c.hour ?? 0) * 60 + (c.minute ?? 0)
            }
        )
        DatePicker("", selection: date, displayedComponents: .hourAndMinute)
            .labelsHidden()
            .datePickerStyle(.field)
            .fixedSize()
    }
}

/// Removable chips that wrap onto several lines.
struct FlowChips: View {
    let items: [String]
    let onRemove: (String) -> Void

    var body: some View {
        ChipLayout(spacing: 6) {
            ForEach(items, id: \.self) { item in
                HStack(spacing: 6) {
                    Text(item).font(.system(size: 12)).lineLimit(1)
                    Button {
                        onRemove(item)
                    } label: {
                        Image(systemName: "xmark").font(.system(size: 8, weight: .bold))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.textDim)
                }
                .padding(.leading, 10)
                .padding(.trailing, 8)
                .frame(height: 26)
                .background(Capsule().fill(Theme.raised))
                .overlay(Capsule().stroke(Theme.borderStrong))
            }
        }
    }
}

struct ChipLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(proposal.width ?? .infinity, subviews)
        return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: rows.last.map { $0.y + $0.height } ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for row in arrange(bounds.width, subviews) {
            for (index, x) in row.items {
                subviews[index].place(at: CGPoint(x: bounds.minX + x, y: bounds.minY + row.y), proposal: .unspecified)
            }
        }
    }

    private struct RowInfo { var items: [(Int, CGFloat)] = []; var width: CGFloat = 0; var height: CGFloat = 0; var y: CGFloat = 0 }

    private func arrange(_ maxWidth: CGFloat, _ subviews: Subviews) -> [RowInfo] {
        var rows = [RowInfo()]
        for (i, view) in subviews.enumerated() {
            let size = view.sizeThatFits(.unspecified)
            if rows[rows.count - 1].width + size.width > maxWidth && !rows[rows.count - 1].items.isEmpty {
                let y = rows[rows.count - 1].y + rows[rows.count - 1].height + spacing
                rows.append(RowInfo(y: y))
            }
            let x = rows[rows.count - 1].items.isEmpty ? 0 : rows[rows.count - 1].width + spacing
            rows[rows.count - 1].items.append((i, x))
            rows[rows.count - 1].width = x + size.width
            rows[rows.count - 1].height = max(rows[rows.count - 1].height, size.height)
        }
        return rows
    }
}
