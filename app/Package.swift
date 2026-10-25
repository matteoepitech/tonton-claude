// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "TontonClaude",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "TontonCore", path: "Sources/TontonCore"),
        .executableTarget(name: "TontonClaude", dependencies: ["TontonCore"], path: "Sources/TontonClaude"),
        .testTarget(name: "TontonCoreTests", dependencies: ["TontonCore"], path: "Tests/TontonCoreTests"),
    ]
)
