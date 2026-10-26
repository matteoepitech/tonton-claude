// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "TontonClaude",
    platforms: [.macOS(.v14)],
    dependencies: [
        // Updates of the app itself (Settings › General). The one dependency: signed appcasts and in-place installs are
        // not something to write again.
        .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.0")
    ],
    targets: [
        .target(name: "TontonCore", path: "Sources/TontonCore"),
        .executableTarget(
            name: "TontonClaude",
            dependencies: ["TontonCore", .product(name: "Sparkle", package: "Sparkle")],
            path: "Sources/TontonClaude",
            // scripts/build-app.sh puts Sparkle.framework in Contents/Frameworks.
            linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]
        ),
        .testTarget(name: "TontonCoreTests", dependencies: ["TontonCore"], path: "Tests/TontonCoreTests"),
    ]
)
