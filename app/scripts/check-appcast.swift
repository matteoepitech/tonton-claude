// Checks the update feed written by the release workflow before it is published, the way the installed apps will: the
// feed and the archive it offers verify with the EdDSA key built into the new app, and the versions match. A key that
// doesn't match the secret would otherwise ship, and apps that reject every update only get past it with a manual install.
// usage: swift scripts/check-appcast.swift <appcast.xml> <archive> <TontonClaude.app>
import CryptoKit
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("check-appcast: \(message)\n".utf8))
    exit(1)
}

let arguments = CommandLine.arguments
guard arguments.count == 4 else { fail("usage: swift scripts/check-appcast.swift <appcast.xml> <archive> <app>") }
let (feedPath, archivePath, appPath) = (arguments[1], arguments[2], arguments[3])

guard let info = NSDictionary(contentsOfFile: "\(appPath)/Contents/Info.plist") as? [String: Any],
    let keyText = info["SUPublicEDKey"] as? String, let keyData = Data(base64Encoded: keyText),
    let key = try? Curve25519.Signing.PublicKey(rawRepresentation: keyData)
else { fail("\(appPath) has no EdDSA public key") }

func verify(_ signature: String?, _ data: Data, _ what: String) {
    guard let signature, let bytes = Data(base64Encoded: signature) else { fail("\(what) has no signature") }
    guard key.isValidSignature(bytes, for: data) else { fail("\(what) does not verify with the app's SUPublicEDKey") }
}

// A signed feed ends with the signature of the bytes before it (see signAppcast in Sparkle's common_cli).
guard let feed = FileManager.default.contents(atPath: feedPath) else { fail("can't read \(feedPath)") }
guard let marker = feed.range(of: Data("<!-- sparkle-signatures:\n".utf8), options: .backwards),
    let block = String(data: feed[marker.lowerBound...], encoding: .utf8)
else { fail("the feed is not signed, but the app requires a signed feed") }
let fields = Dictionary(
    block.split(separator: "\n").compactMap { line -> (String, String)? in
        let parts = line.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
        return parts.count == 2 ? (parts[0], parts[1]) : nil
    }, uniquingKeysWith: { first, _ in first })
guard fields["length"] == String(marker.lowerBound) else { fail("the feed's signature doesn't cover the whole feed") }
verify(fields["edSignature"], feed[..<marker.lowerBound], "the feed")

let document = try XMLDocument(data: feed[..<marker.lowerBound])
let items = try document.nodes(forXPath: "/rss/channel/item").compactMap { $0 as? XMLElement }
guard items.count == 1, let item = items.first else { fail("expected one item in the feed, found \(items.count)") }
guard let enclosure = item.elements(forName: "enclosure").first else { fail("the item has no enclosure") }
func attribute(_ name: String) -> String? { enclosure.attribute(forName: name)?.stringValue }

guard let archive = FileManager.default.contents(atPath: archivePath) else { fail("can't read \(archivePath)") }
let archiveName = URL(fileURLWithPath: archivePath).lastPathComponent
guard let url = attribute("url").flatMap(URL.init(string:)), url.scheme == "https", url.lastPathComponent == archiveName
else { fail("the enclosure doesn't point to \(archiveName) over https: \(attribute("url") ?? "none")") }
guard attribute("length") == String(archive.count) else { fail("the enclosure's length isn't the archive's") }
verify(attribute("sparkle:edSignature"), archive, archiveName)

let version = item.elements(forName: "sparkle:version").first?.stringValue
guard let version, version == info["CFBundleVersion"] as? String else { fail("the item's version \(version ?? "none") isn't the app's") }
print("OK: \(feedPath) offers \(archiveName), build \(version), signed with the app's key")
