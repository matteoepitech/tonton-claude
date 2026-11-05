import CoreGraphics

/// The notch's dropdowns (NotchMenu in the app): where the list goes, and which choice the arrows go to next.
public enum Dropdown {
    /// The list's frame in the notch, for its ideal size: under the button, or over it when there is more room above,
    /// its height capped to that room; aligned with the button's nearer edge and kept inside the bounds.
    public static func frame(ideal: CGSize, button: CGRect, in bounds: CGSize, gap: CGFloat = 4, margin: CGFloat = 6) -> CGRect {
        let below = bounds.height - button.maxY - gap - margin
        let above = button.minY - gap - margin
        let down = ideal.height <= below || below >= above
        let height = min(ideal.height, max(80, down ? below : above))
        let width = min(ideal.width, bounds.width - margin * 2)
        let x = button.midX > bounds.width / 2 ? button.maxX - width : button.minX
        let y = down ? button.maxY + gap : button.minY - gap - height
        return CGRect(x: min(max(x, margin), bounds.width - width - margin), y: y, width: width, height: height)
    }

    /// The choice after `current` going `step` ways, wrapping around; the first or the last one when none is lit yet.
    public static func step<ID: Equatable>(_ ids: [ID], from current: ID?, by step: Int) -> ID? {
        guard !ids.isEmpty else { return nil }
        guard let index = ids.firstIndex(where: { $0 == current }) else { return step > 0 ? ids.first : ids.last }
        return ids[((index + step) % ids.count + ids.count) % ids.count]
    }
}
