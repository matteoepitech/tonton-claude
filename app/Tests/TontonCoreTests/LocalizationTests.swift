import Foundation
import XCTest

@testable import TontonCore

/// The string catalogs in Resources: every string in French with the same values in it, French punctuation, and the
/// English as the code writes it. scripts/sync-strings.sh --check (CI) makes sure every string of the code is there.
final class LocalizationTests: XCTestCase {
    private struct Entry {
        let key: String
        let stale: Bool
        /// Per variation: "" for a plain string, otherwise the plural category ("one", "other"…).
        let english: [String: String]
        let french: [String: String]
        let untranslated: Bool
        let substitutions: Bool
        /// False for what has no words to translate, such as the hidden label of a control ("").
        let translate: Bool
        /// The code gives the English as a `defaultValue`, to tell two meanings of one English word apart.
        let englishInCode: Bool
    }

    private func entries(_ name: String = "Localizable") throws -> [Entry] {
        let url = Catalog.source.deletingLastPathComponent().appendingPathComponent("\(name).xcstrings")
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let strings = try XCTUnwrap(json["strings"] as? [String: [String: Any]])
        return strings.map { key, entry in
            let localizations = entry["localizations"] as? [String: [String: Any]] ?? [:]
            var untranslated = false
            func values(_ language: String) -> [String: String] {
                guard let localization = localizations[language] else { return [:] }
                var values: [String: String] = [:]
                func read(_ unit: Any?, as name: String) {
                    guard let unit = (unit as? [String: Any])?["stringUnit"] as? [String: Any] else { return }
                    values[name] = unit["value"] as? String ?? ""
                    if language == "fr", unit["state"] as? String != "translated" { untranslated = true }
                }
                read(localization, as: "")
                let plural = (localization["variations"] as? [String: Any])?["plural"] as? [String: Any] ?? [:]
                for (category, unit) in plural { read(unit, as: category) }
                return values
            }
            let state = entry["extractionState"] as? String
            return Entry(
                key: key, stale: state == "stale", english: values("en"), french: values("fr"), untranslated: untranslated,
                substitutions: localizations.values.contains { $0["substitutions"] != nil },
                translate: entry["shouldTranslate"] as? Bool != false, englishInCode: state == "extracted_with_value")
        }
        .sorted { $0.key < $1.key }
    }

    private func check(_ problems: [String], _ what: String) {
        XCTAssert(problems.isEmpty, "\(problems.count) \(what):\n" + problems.joined(separator: "\n"))
    }

    func testEveryStringIsInFrench() throws {
        for catalog in ["Localizable", "InfoPlist"] {
            let entries = try entries(catalog)
            XCTAssertFalse(entries.isEmpty)
            check(entries.filter(\.stale).map(\.key), "strings the code no longer has, to delete from \(catalog).xcstrings")
            let missing = entries.filter { $0.translate && ($0.french.values.allSatisfy(\.isEmpty) || $0.untranslated) }
            check(missing.map(\.key), "strings to translate")
        }
    }

    /// `%@`, `%lld`… in the same number and kinds, in any order when they are numbered (`%2$@`). The plural forms keep
    /// the number: French uses "one" for 0 too.
    func testTheFrenchKeepsTheValues() throws {
        var problems: [String] = []
        for entry in try entries() {
            let expected = Self.specifiers(entry.key)
            for (variation, value) in entry.french.map({ ("fr \($0)", $1) }) + entry.english.map({ ("en \($0)", $1) }) {
                if Self.specifiers(value) != expected { problems.append("\(entry.key) [\(variation)]: \(value)") }
                // With values, % is written %%; without, the text shows as it is.
                if expected != nil, Self.leftover(value) { problems.append("\(entry.key): a lone % in \(value), write %%") }
                if expected == nil, value.contains("%%") { problems.append("\(entry.key): %% shows as it is in \(value)") }
            }
            if entry.substitutions { problems.append("\(entry.key): two plurals in one string, split it") }
        }
        check(problems, "translations that lose or add a value")
    }

    /// The key is the English text, so the English stays what the code says. xcstringstool numbers the values of the
    /// keys that have several (`%1$@ in %2$@`), and plurals add one form: one, and other is the key.
    func testTheEnglishIsTheCode() throws {
        var problems: [String] = []
        for entry in try entries() where !entry.english.isEmpty {
            let english = entry.english.mapValues { $0.replacing(#/%\d+\$/#, with: "%") }
            if let text = english[""], text != entry.key, !entry.englishInCode {
                problems.append("\(entry.key): the English is \(text), change the code instead")
            }
            let plural = english.filter { !$0.key.isEmpty }
            if !plural.isEmpty, plural["other"] != entry.key || plural["one"] == nil || plural.count != 2 {
                problems.append("\(entry.key): the English plural needs one, and other the same as the key")
            }
        }
        for entry in try entries() where entry.french.count > 1 && (entry.french["one"] == nil || entry.french["other"] == nil) {
            problems.append("\(entry.key): the French plural needs one and other")
        }
        check(problems, "English forms")
    }

    /// The Info.plist's own English, which the English of InfoPlist.xcstrings replaces.
    func testTheInfoPlistStringsHaveItsEnglish() throws {
        let app = Catalog.source.deletingLastPathComponent().deletingLastPathComponent()
        let script = try String(contentsOf: app.appendingPathComponent("scripts/build-app.sh"), encoding: .utf8)
        for entry in try entries("InfoPlist") {
            XCTAssert(script.contains("<key>\(entry.key)</key><string>\(entry.english[""] ?? "")</string>"), entry.key)
        }
    }

    /// As macOS writes French: a no-break space before : ; ? ! and inside « », typographic apostrophes, an ellipsis.
    func testFrenchPunctuation() throws {
        let rules: [(Regex<Substring>, String)] = [
            (#/ [:;?!]/#, "a no-break space before : ; ? !"),
            (#/[^\s\u{A0}\u{202F}][;?!](?:\s|$)/#, "a no-break space before ; ? !"),
            (#/[^\s\u{A0}\u{202F}\d]:(?:\s|$)/#, "a no-break space before :"),
            (#/'/#, "’ for an apostrophe"),
            (#/\.\.\./#, "… for an ellipsis"),
            (#/[“”"]/#, "« » for quotes"),
            (#/«[^\u{A0}]|[^\u{A0}]»/#, "a no-break space inside « »"),
        ]
        var problems: [String] = []
        for entry in try entries() + entries("InfoPlist") {
            for value in entry.french.values {
                // Code, commands and paths keep their own punctuation.
                let prose = value.replacing(#/`[^`]*`/#, with: "")
                for (rule, advice) in rules where prose.contains(rule) { problems.append("\(value): \(advice)") }
            }
        }
        check(problems, "French punctuation mistakes")
    }

    /// Each value's kind by its position: `%@ and %lld` and `%2$lld et %1$@` both give [1: "@", 2: "lld"]. Nil without any.
    private static func specifiers(_ text: String) -> [Int: String]? {
        var found: [Int: String] = [:]
        var next = 1
        for match in text.matches(of: specifier) where match.output.kind != "%" {
            let position = match.output.position.flatMap { Int($0) } ?? next
            found[position] = String(match.output.kind)
            next = position + 1
        }
        return found.isEmpty ? nil : found
    }

    private static func leftover(_ text: String) -> Bool {
        text.replacing(specifier, with: "").contains("%")
    }

    private static let specifier = #/%(?:(?<position>\d+)\$)?[-+ 0#]*\d*(?:\.\d+)?(?<kind>%|(?:hh|h|ll|l|q|z|t|j)?[@dDiuUxXoOfFeEgGcCsSp])/#
}
