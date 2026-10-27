import Foundation

/// What Claude costs, in US dollars at list price: `$12.40` in English, `12,40 $` in French. The decimal mark follows the
/// language and not the region, so the English text stays what it always was.
public enum Money {
    public static func dollars(_ value: Double, digits: Int = 2) -> String {
        let language = Locale(identifier: Strings.locale.language.languageCode?.identifier ?? "en")
        let amount = String(format: "%.\(digits)f", locale: language, value)
        return String(core: "$\(amount)")
    }
}
