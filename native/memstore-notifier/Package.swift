// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "memstore-notifier",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "MemStoreNotifierCore", targets: ["MemStoreNotifierCore"]),
        .executable(name: "memstore-notifier", targets: ["memstore-notifier"])
    ],
    targets: [
        .target(name: "MemStoreNotifierCore"),
        .executableTarget(
            name: "memstore-notifier",
            dependencies: ["MemStoreNotifierCore"]
        ),
        .testTarget(
            name: "MemStoreNotifierCoreTests",
            dependencies: ["MemStoreNotifierCore"]
        )
    ]
)
