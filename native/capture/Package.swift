// swift-tools-version: 6.0

import Foundation
import PackageDescription

// Command Line Tools ships Swift Testing as a developer framework, but unlike
// full Xcode it does not always add the framework search path to test targets.
let developerDirectory = ProcessInfo.processInfo.environment["DEVELOPER_DIR"]
    ?? "/Library/Developer/CommandLineTools"
let developerFrameworks = "\(developerDirectory)/Library/Developer/Frameworks"
let packageDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path
let executableInfoPlist = "\(packageDirectory)/Sources/replay-capture/Info.plist"
let testingSwiftSettings: [SwiftSetting] = [
    .unsafeFlags([
        "-F", developerFrameworks,
        // The CLT 26.2 bundle advertises a Foundation cross-import overlay
        // without shipping its Swift module. The overlay is optional for these
        // tests, so disable automatic loading in that environment.
        "-Xfrontend", "-disable-cross-import-overlays"
    ])
]
let testingLinkerSettings: [LinkerSetting] = [
    .unsafeFlags(["-F", developerFrameworks]),
    .linkedFramework("Testing")
]

let package = Package(
    name: "ReplayCapture",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(name: "ReplayCaptureCore", targets: ["ReplayCaptureCore"]),
        .library(name: "ReplayCaptureMac", targets: ["ReplayCaptureMac"]),
        .executable(name: "replay-capture", targets: ["replay-capture"])
    ],
    targets: [
        .target(name: "ReplayCaptureCore"),
        .target(
            name: "ReplayCaptureMac",
            dependencies: ["ReplayCaptureCore"],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("ScreenCaptureKit")
            ]
        ),
        .executableTarget(
            name: "replay-capture",
            dependencies: ["ReplayCaptureCore", "ReplayCaptureMac"],
            exclude: ["Info.plist"],
            linkerSettings: [
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", executableInfoPlist
                ])
            ]
        ),
        .testTarget(
            name: "ReplayCaptureCoreTests",
            dependencies: ["ReplayCaptureCore"],
            swiftSettings: testingSwiftSettings,
            linkerSettings: testingLinkerSettings
        ),
        .testTarget(
            name: "ReplayCaptureMacTests",
            dependencies: ["ReplayCaptureCore", "ReplayCaptureMac"],
            swiftSettings: testingSwiftSettings,
            linkerSettings: testingLinkerSettings
        )
    ]
)
