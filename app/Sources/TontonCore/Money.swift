import Foundation

/// What Claude costs, in US dollars at list price: `$12.40` in English, `12,40 $` in French.
public enum Money {
    public static func dollars(_ value: Double, digits: Int = 2) -> String {
        let amount = String(format: "%.\(digits)f", locale: Strings.numbers, value)
        return String(core: "$\(amount)")
    }
}
