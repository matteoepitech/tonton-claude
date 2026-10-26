/// How dark the veil over the open notch's frosted glass is, from the transparency setting: 0 is opaque, 0.5 the
/// original look, 1 the clearest it gets. The veil never goes below a floor, so text stays readable over any desktop.
public struct GlassVeil: Equatable, Sendable {
    /// Opacity of the black veil right under the camera band, and at the bottom of the notch.
    public let top: Double
    public let bottom: Double

    static let original = GlassVeil(top: 0.62, bottom: 0.45)
    static let clearest = GlassVeil(top: 0.48, bottom: 0.35)

    init(top: Double, bottom: Double) {
        self.top = top
        self.bottom = bottom
    }

    public init(transparency: Double) {
        let t = min(max(transparency, 0), 1)
        func blend(_ from: Double, _ to: Double, _ amount: Double) -> Double { from * (1 - amount) + to * amount }
        if t <= 0.5 {
            self.init(top: blend(1, Self.original.top, t * 2), bottom: blend(1, Self.original.bottom, t * 2))
        } else {
            let amount = (t - 0.5) * 2
            self.init(
                top: blend(Self.original.top, Self.clearest.top, amount), bottom: blend(Self.original.bottom, Self.clearest.bottom, amount))
        }
    }
}
