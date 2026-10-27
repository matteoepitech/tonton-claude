import Foundation

/// Where TontonCore finds the text it shows. In the app and the widget, scripts/build-app.sh compiles
/// Resources/Localizable.xcstrings into one .lproj folder per language of their own bundle, which is also where the views
/// find theirs. SwiftPM can't: it would copy the catalog uncompiled into a resource bundle at the root of the .app, where
/// the signature does not allow it. Tests point this at the catalog compiled in one language, to check its plurals and
/// its French.
public enum Strings {
    nonisolated(unsafe) public static var bundle = Bundle.main
    /// Picks the plural forms and writes the numbers. The app's language and the current locale's always agree: macOS
    /// gives the process the language of the app's localization it runs in.
    nonisolated(unsafe) public static var locale = Locale.autoupdatingCurrent

    /// Writes the decimals of costs, sizes and token counts: `4.2` in English, `4,2` in French. By the language, not
    /// the region, so the English text stays what it always was.
    public static var numbers: Locale { Locale(identifier: locale.language.languageCode?.identifier ?? "en") }
}

extension String {
    /// `String(localized:)` from `Strings`, for TontonCore. Xcode and scripts/sync-strings.sh find the literal the same
    /// way, so it goes in the catalog with the views' strings.
    public init(core value: LocalizationValue) {
        self.init(localized: value, bundle: Strings.bundle, locale: Strings.locale)
    }
}
