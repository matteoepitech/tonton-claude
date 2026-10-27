// swift-tools-version:5.10
import PackageDescription

// TontonCore is shared with the iPhone app (../ios), so it builds for iOS too. What reads this Mac's own files stays in
// TontonMac.
let package = Package(
    name: "TontonClaude",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.library(name: "TontonCore", targets: ["TontonCore"])],
    dependencies: [
        // Updates of the app itself (Settings › General). The one dependency: signed appcasts and in-place installs are
        // not something to write again.
        .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.0")
    ],
    targets: [
        .target(name: "TontonCore", path: "Sources/TontonCore"),
        .target(name: "TontonMac", dependencies: ["TontonCore"], path: "Sources/TontonMac"),
        .executableTarget(
            name: "TontonClaude",
            dependencies: ["TontonCore", "TontonMac", .product(name: "Sparkle", package: "Sparkle")],
            path: "Sources/TontonClaude",
            // scripts/build-app.sh puts Sparkle.framework in Contents/Frameworks.
            linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]
        ),
        // The desktop and Notification Center widget. SwiftPM can't make an app extension: scripts/build-app.sh wraps this
        // executable into Contents/PlugIns/TontonWidget.appex.
        .executableTarget(
            name: "TontonWidget",
            dependencies: ["TontonCore"],
            path: "Sources/TontonWidget",
            swiftSettings: [.unsafeFlags(["-application-extension"])],
            linkerSettings: [.unsafeFlags(["-Xlinker", "-application_extension"])]
        ),
        .testTarget(name: "TontonCoreTests", dependencies: ["TontonCore"], path: "Tests/TontonCoreTests"),
        .testTarget(name: "TontonMacTests", dependencies: ["TontonMac", "TontonCore"], path: "Tests/TontonMacTests"),
    ]
)
