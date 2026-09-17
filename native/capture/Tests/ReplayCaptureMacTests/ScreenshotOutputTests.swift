import Foundation
import Testing
@testable import ReplayCaptureMac
import ReplayCaptureCore

@Test func preparingOutputCreatesAMissingFolderWhenAllowed() throws {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("ReplayScreenshotOutput-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let output = root.appendingPathComponent("nested/shot.png")

    try prepareScreenshotOutput(at: output, createDirectories: true)

    var isDirectory: ObjCBool = false
    #expect(FileManager.default.fileExists(atPath: output.deletingLastPathComponent().path, isDirectory: &isDirectory))
    #expect(isDirectory.boolValue)
}

@Test func preparingOutputRefusesAMissingFolderWhenNotAllowed() throws {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("ReplayScreenshotOutput-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let output = root.appendingPathComponent("swept/shot.png")

    #expect(throws: SidecarOperationError.self) {
        try prepareScreenshotOutput(at: output, createDirectories: false)
    }
    #expect(!FileManager.default.fileExists(atPath: output.deletingLastPathComponent().path))
}

@Test func preparingOutputAcceptsAnExistingFolderWhenNotAllowedToCreate() throws {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("ReplayScreenshotOutput-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    try prepareScreenshotOutput(at: root.appendingPathComponent("shot.png"), createDirectories: false)
}
