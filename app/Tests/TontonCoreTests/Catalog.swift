import Foundation
import XCTest

@testable import TontonCore

/// Resources/Localizable.xcstrings, compiled once per run as scripts/build-app.sh compiles it, for the tests that read
/// TontonCore's text in one language: the plurals only exist compiled.
enum Catalog {
    static let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("Resources/Localizable.xcstrings")

    private static let compiled = Result<URL, any Error> { try compile() }

    /// TontonCore reads its strings in `language` until `reset`.
    static func use(_ language: String) throws {
        let folder = try compiled.get().appendingPathComponent("\(language).lproj")
        guard let bundle = Bundle(url: folder) else { throw XCTSkip("the catalog has no \(language)") }
        Strings.bundle = bundle
        Strings.locale = Locale(identifier: language)
    }

    static func reset() {
        Strings.bundle = .main
        Strings.locale = .autoupdatingCurrent
    }

    private static func compile() throws -> URL {
        let output = FileManager.default.temporaryDirectory.appendingPathComponent("tonton-strings-\(UUID().uuidString)")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        process.arguments = ["xcstringstool", "compile", source.path, "--output-directory", output.path]
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw XCTSkip("compiling the catalog takes Xcode's xcstringstool") }
        return output
    }
}
