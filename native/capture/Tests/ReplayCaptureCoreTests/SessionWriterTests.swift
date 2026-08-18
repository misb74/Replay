import Foundation
import Testing
@testable import ReplayCaptureCore

@Test func eventAndPartialMetadataAreVisibleBeforeRecordingStops() async throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let configuration = SessionConfiguration(
        sessionId: "session-1",
        directory: directory,
        includeAudio: false,
        display: .init(width: 100, height: 50, scale: 2),
        appVersions: ["capture": "test"]
    )
    let writer = try await SessionWriter.create(
        configuration: configuration,
        startedAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
    let event = EventSanitizer.sanitize(
        .click(
            id: "event-1",
            sessionId: "session-1",
            timestampMs: 12,
            position: .init(x: 10, y: 20),
            button: .left,
            clickCount: 1
        ),
        target: AccessibilityTarget(role: "AXButton", label: "Submit")
    )

    try await writer.append(event)

    let lineData = try Data(contentsOf: directory.appendingPathComponent("events.jsonl"))
    let persistedText = try #require(String(data: lineData, encoding: .utf8))
    let lines = persistedText.split(separator: "\n")
    #expect(lines.count == 1)
    let persisted = try JSONDecoder.replay.decode(CapturedEvent.self, from: Data(lines[0].utf8))
    #expect(persisted.target?.label == "Submit")

    let metadata = try loadMetadata(directory)
    #expect(metadata.status == .recording)
    #expect(metadata.partial)
    #expect(metadata.eventCount == 1)
    #expect(metadata.lastEventTimestampMs == 12)
}

@Test func completingSessionClearsPartialFlag() async throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let writer = try await SessionWriter.create(
        configuration: .init(
            sessionId: "session-1",
            directory: directory,
            includeAudio: false,
            display: .init(width: 100, height: 50, scale: 1)
        ),
        startedAt: Date(timeIntervalSince1970: 100)
    )

    try await writer.finish(at: Date(timeIntervalSince1970: 120))

    let metadata = try loadMetadata(directory)
    #expect(metadata.status == .completed)
    #expect(!metadata.partial)
    #expect(metadata.stoppedAt == Date(timeIntervalSince1970: 120))
}

@Test func interruptedSessionRemainsExplicitlyPartial() async throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let writer = try await SessionWriter.create(
        configuration: .init(
            sessionId: "session-1",
            directory: directory,
            includeAudio: false,
            display: .init(width: 100, height: 50, scale: 1)
        )
    )

    try await writer.markInterrupted(at: Date(timeIntervalSince1970: 200), reason: "sidecar_shutdown")

    let metadata = try loadMetadata(directory)
    #expect(metadata.status == .interrupted)
    #expect(metadata.partial)
    #expect(metadata.interruptionReason == "sidecar_shutdown")
}

@Test func interruptionCanStillBePersistedAfterTheEventHandleCloses() async throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let writer = try await SessionWriter.create(
        configuration: .init(
            sessionId: "session-1",
            directory: directory,
            includeAudio: false,
            display: .init(width: 100, height: 50, scale: 1)
        )
    )
    await writer.closeForTestingWithoutFinalizing()

    try await writer.markInterrupted(reason: "finalization_failed")

    let metadata = try loadMetadata(directory)
    #expect(metadata.status == .interrupted)
    #expect(metadata.partial)
    #expect(metadata.interruptionReason == "finalization_failed")
}

@Test func recoveryMarksAnUnfinishedRecordingInterruptedWithoutLosingEvents() async throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let writer = try await SessionWriter.create(
        configuration: .init(
            sessionId: "session-1",
            directory: directory,
            includeAudio: false,
            display: .init(width: 100, height: 50, scale: 1)
        )
    )
    try await writer.append(EventSanitizer.sanitize(
        .key(
            id: "event-1",
            sessionId: "session-1",
            timestampMs: 3,
            keyCode: 0,
            text: "a",
            modifiers: []
        ),
        target: nil
    ))
    await writer.closeForTestingWithoutFinalizing()

    let recovered = try SessionRecovery.recoverIfNeeded(at: directory)

    #expect(recovered)
    #expect(try loadMetadata(directory).status == .interrupted)
    let events = try String(contentsOf: directory.appendingPathComponent("events.jsonl"), encoding: .utf8)
    #expect(events.contains("event-1"))
}

@Test func recoveryPromotesTheUniqueNonemptyValidWriterSidecar() async throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    try await createUnfinishedSession(at: directory)

    let videoURL = directory.appendingPathComponent(SessionWriter.videoFileName)
    let candidateURL = directory.appendingPathComponent("video.mp4.sb-valid")
    let emptyCandidateURL = directory.appendingPathComponent("video.mp4.sb-empty")
    #expect(FileManager.default.createFile(atPath: videoURL.path, contents: nil))
    #expect(FileManager.default.createFile(atPath: emptyCandidateURL.path, contents: nil))
    let expectedVideo = makeStructurallyValidRecoveryVideo()
    try expectedVideo.write(to: candidateURL)
    try FileManager.default.setAttributes(
        [.posixPermissions: 0o644],
        ofItemAtPath: candidateURL.path
    )
    let recoveredAt = Date(timeIntervalSince1970: 300)

    let recovered = try SessionRecovery.recoverIfNeeded(
        at: directory,
        recoveredAt: recoveredAt
    )

    #expect(recovered)
    #expect(try Data(contentsOf: videoURL) == expectedVideo)
    #expect(!FileManager.default.fileExists(atPath: candidateURL.path))
    #expect(FileManager.default.fileExists(atPath: emptyCandidateURL.path))
    let attributes = try FileManager.default.attributesOfItem(atPath: videoURL.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    let metadata = try loadMetadata(directory)
    #expect(metadata.status == .interrupted)
    #expect(metadata.partial)
    #expect(metadata.stoppedAt == recoveredAt)
    #expect(metadata.interruptionReason == "sidecar_terminated")
}

@Test func recoveryPromotesAValidWriterSidecarWhenVideoIsMissing() async throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    try await createUnfinishedSession(at: directory)
    let videoURL = directory.appendingPathComponent(SessionWriter.videoFileName)
    let candidateURL = directory.appendingPathComponent("video.mp4.sb-valid")
    let expectedVideo = makeStructurallyValidRecoveryVideo()
    try expectedVideo.write(to: candidateURL)

    let recovered = try SessionRecovery.recoverIfNeeded(at: directory)

    #expect(recovered)
    #expect(try Data(contentsOf: videoURL) == expectedVideo)
    #expect(!FileManager.default.fileExists(atPath: candidateURL.path))
}

@Test func recoveryLeavesAmbiguousWriterSidecarsUntouched() async throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    try await createUnfinishedSession(at: directory)
    let videoURL = directory.appendingPathComponent(SessionWriter.videoFileName)
    let firstCandidate = directory.appendingPathComponent("video.mp4.sb-first")
    let secondCandidate = directory.appendingPathComponent("video.mp4.sb-second")
    #expect(FileManager.default.createFile(atPath: videoURL.path, contents: nil))
    try makeStructurallyValidRecoveryVideo().write(to: firstCandidate)
    try makeStructurallyValidRecoveryVideo().write(to: secondCandidate)

    let recovered = try SessionRecovery.recoverIfNeeded(at: directory)

    #expect(recovered)
    #expect(try Data(contentsOf: videoURL).isEmpty)
    #expect(FileManager.default.fileExists(atPath: firstCandidate.path))
    #expect(FileManager.default.fileExists(atPath: secondCandidate.path))
    #expect(try loadMetadata(directory).partial)
}

@Test func recoveryLeavesMalformedWriterSidecarUntouched() async throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    try await createUnfinishedSession(at: directory)
    let videoURL = directory.appendingPathComponent(SessionWriter.videoFileName)
    let candidateURL = directory.appendingPathComponent("video.mp4.sb-malformed")
    #expect(FileManager.default.createFile(atPath: videoURL.path, contents: nil))
    try Data("not a QuickTime movie".utf8).write(to: candidateURL)

    let recovered = try SessionRecovery.recoverIfNeeded(at: directory)

    #expect(recovered)
    #expect(try Data(contentsOf: videoURL).isEmpty)
    #expect(FileManager.default.fileExists(atPath: candidateURL.path))
    #expect(try loadMetadata(directory).status == .interrupted)
}

@Test func recoveryNeverOverwritesAnExistingNonemptyVideo() async throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    try await createUnfinishedSession(at: directory)
    let videoURL = directory.appendingPathComponent(SessionWriter.videoFileName)
    let candidateURL = directory.appendingPathComponent("video.mp4.sb-valid")
    let existingVideo = Data("already finalized".utf8)
    try existingVideo.write(to: videoURL)
    try makeStructurallyValidRecoveryVideo().write(to: candidateURL)

    let recovered = try SessionRecovery.recoverIfNeeded(at: directory)

    #expect(recovered)
    #expect(try Data(contentsOf: videoURL) == existingVideo)
    #expect(FileManager.default.fileExists(atPath: candidateURL.path))
}

@Test func recoveryRejectsASymbolicLinkCandidateWithoutTouchingItsTarget() async throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    try await createUnfinishedSession(at: directory)
    let manager = FileManager.default
    let videoURL = directory.appendingPathComponent(SessionWriter.videoFileName)
    let outsideURL = directory.appendingPathComponent("outside.mp4")
    let candidateURL = directory.appendingPathComponent("video.mp4.sb-link")
    let expectedVideo = makeStructurallyValidRecoveryVideo()
    #expect(manager.createFile(atPath: videoURL.path, contents: nil))
    try expectedVideo.write(to: outsideURL)
    try manager.setAttributes([.posixPermissions: 0o644], ofItemAtPath: outsideURL.path)
    try manager.createSymbolicLink(at: candidateURL, withDestinationURL: outsideURL)

    let recovered = try SessionRecovery.recoverIfNeeded(at: directory)

    #expect(recovered)
    #expect(try Data(contentsOf: videoURL).isEmpty)
    #expect(try candidateURL.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink == true)
    #expect(try Data(contentsOf: outsideURL) == expectedVideo)
    let attributes = try manager.attributesOfItem(atPath: outsideURL.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o644)
}

@Test func recoveryRejectsASymbolicLinkPublicVideo() async throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    try await createUnfinishedSession(at: directory)
    let manager = FileManager.default
    let videoURL = directory.appendingPathComponent(SessionWriter.videoFileName)
    let outsideURL = directory.appendingPathComponent("outside-empty.mp4")
    let candidateURL = directory.appendingPathComponent("video.mp4.sb-valid")
    #expect(manager.createFile(atPath: outsideURL.path, contents: nil))
    try manager.createSymbolicLink(at: videoURL, withDestinationURL: outsideURL)
    try makeStructurallyValidRecoveryVideo().write(to: candidateURL)

    let recovered = try SessionRecovery.recoverIfNeeded(at: directory)

    #expect(recovered)
    #expect(try videoURL.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink == true)
    #expect(try Data(contentsOf: outsideURL).isEmpty)
    #expect(FileManager.default.fileExists(atPath: candidateURL.path))
}

@Test func recoveryRejectsNonregularCandidateAndDestinationPaths() async throws {
    let candidateDirectory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: candidateDirectory) }
    try await createUnfinishedSession(at: candidateDirectory)
    let candidateVideo = candidateDirectory.appendingPathComponent(SessionWriter.videoFileName)
    let nonregularCandidate = candidateDirectory.appendingPathComponent(
        "video.mp4.sb-directory",
        isDirectory: true
    )
    #expect(FileManager.default.createFile(atPath: candidateVideo.path, contents: nil))
    try FileManager.default.createDirectory(at: nonregularCandidate, withIntermediateDirectories: false)

    #expect(try SessionRecovery.recoverIfNeeded(at: candidateDirectory))
    #expect(try Data(contentsOf: candidateVideo).isEmpty)
    #expect(try nonregularCandidate.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true)

    let destinationDirectory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: destinationDirectory) }
    try await createUnfinishedSession(at: destinationDirectory)
    let nonregularVideo = destinationDirectory.appendingPathComponent(
        SessionWriter.videoFileName,
        isDirectory: true
    )
    let validCandidate = destinationDirectory.appendingPathComponent("video.mp4.sb-valid")
    try FileManager.default.createDirectory(at: nonregularVideo, withIntermediateDirectories: false)
    try makeStructurallyValidRecoveryVideo().write(to: validCandidate)

    #expect(try SessionRecovery.recoverIfNeeded(at: destinationDirectory))
    #expect(try nonregularVideo.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true)
    #expect(FileManager.default.fileExists(atPath: validCandidate.path))
}

@Test func recoveryRejectsAHardLinkedCandidateWithoutChangingItsMode() async throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    try await createUnfinishedSession(at: directory)
    let manager = FileManager.default
    let videoURL = directory.appendingPathComponent(SessionWriter.videoFileName)
    let outsideURL = directory.appendingPathComponent("outside.mp4")
    let candidateURL = directory.appendingPathComponent("video.mp4.sb-hard-link")
    #expect(manager.createFile(atPath: videoURL.path, contents: nil))
    try makeStructurallyValidRecoveryVideo().write(to: outsideURL)
    try manager.setAttributes([.posixPermissions: 0o644], ofItemAtPath: outsideURL.path)
    try manager.linkItem(at: outsideURL, to: candidateURL)

    #expect(try SessionRecovery.recoverIfNeeded(at: directory))
    #expect(try Data(contentsOf: videoURL).isEmpty)
    #expect(FileManager.default.fileExists(atPath: candidateURL.path))
    let attributes = try manager.attributesOfItem(atPath: outsideURL.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o644)
}

@Test func recoveryRejectsACandidatePathSwapAfterValidation() async throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    try await createUnfinishedSession(at: directory)
    let manager = FileManager.default
    let videoURL = directory.appendingPathComponent(SessionWriter.videoFileName)
    let candidateURL = directory.appendingPathComponent("video.mp4.sb-valid")
    let heldURL = directory.appendingPathComponent("validated-original.mp4")
    let video = makeStructurallyValidRecoveryVideo()
    #expect(manager.createFile(atPath: videoURL.path, contents: nil))
    try video.write(to: candidateURL)

    let recovered = try SessionRecovery.recoverIfNeeded(
        at: directory,
        afterVideoValidation: {
            try manager.moveItem(at: candidateURL, to: heldURL)
            try video.write(to: candidateURL)
        }
    )

    #expect(recovered)
    #expect(try Data(contentsOf: videoURL).isEmpty)
    #expect(try Data(contentsOf: candidateURL) == video)
    #expect(try Data(contentsOf: heldURL) == video)
}

@Test func recoveryRejectsAPublicVideoPathSwapAfterValidation() async throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    try await createUnfinishedSession(at: directory)
    let manager = FileManager.default
    let videoURL = directory.appendingPathComponent(SessionWriter.videoFileName)
    let candidateURL = directory.appendingPathComponent("video.mp4.sb-valid")
    let protectedVideo = Data("created while recovery was validating".utf8)
    #expect(manager.createFile(atPath: videoURL.path, contents: nil))
    try makeStructurallyValidRecoveryVideo().write(to: candidateURL)

    let recovered = try SessionRecovery.recoverIfNeeded(
        at: directory,
        afterVideoValidation: {
            try manager.removeItem(at: videoURL)
            try protectedVideo.write(to: videoURL)
        }
    )

    #expect(recovered)
    #expect(try Data(contentsOf: videoURL) == protectedVideo)
    #expect(FileManager.default.fileExists(atPath: candidateURL.path))
}

@Test func secureTextNeverAppearsAnywhereInSessionDirectory() async throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let writer = try await SessionWriter.create(
        configuration: .init(
            sessionId: "session-1",
            directory: directory,
            includeAudio: false,
            display: .init(width: 100, height: 50, scale: 1)
        )
    )
    let secret = "correct horse battery staple"
    let event = EventSanitizer.sanitize(
        .key(
            id: "event-1",
            sessionId: "session-1",
            timestampMs: 1,
            keyCode: 0,
            text: secret,
            modifiers: []
        ),
        target: AccessibilityTarget(
            role: "AXSecureTextField",
            label: "Password",
            value: secret,
            isSecure: true
        )
    )

    try await writer.append(event)
    try await writer.finish()

    for file in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
        let data = try Data(contentsOf: file)
        #expect(data.range(of: Data(secret.utf8)) == nil, Comment(rawValue: file.lastPathComponent))
    }
}

@Test func writerRedactsAnUnsafeExternallyDecodedEvent() async throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let writer = try await SessionWriter.create(
        configuration: .init(
            sessionId: "session-1",
            directory: directory,
            includeAudio: false,
            display: .init(width: 100, height: 50, scale: 1)
        )
    )
    let unsafeJSON = #"{"schemaVersion":1,"id":"unsafe","sessionId":"session-1","timestampMs":1,"type":"key","key":{"keyCode":0,"text":"must-not-persist","modifiers":[],"redacted":false}}"#
    let unsafeEvent = try JSONDecoder.replay.decode(
        CapturedEvent.self,
        from: Data(unsafeJSON.utf8)
    )

    try await writer.append(unsafeEvent)
    try await writer.finish()

    let contents = try String(
        contentsOf: directory.appendingPathComponent("events.jsonl"),
        encoding: .utf8
    )
    #expect(!contents.contains("must-not-persist"))
    #expect(contents.contains(Redaction.marker))
}

@Test func writerRedactsSecureTargetsForEveryEventType() async throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let writer = try await SessionWriter.create(
        configuration: .init(
            sessionId: "session-1",
            directory: directory,
            includeAudio: false,
            display: .init(width: 100, height: 50, scale: 1)
        )
    )
    let secret = "secure-click-value"
    let unsafeJSON = #"{"schemaVersion":1,"id":"unsafe-click","sessionId":"session-1","timestampMs":1,"type":"click","position":{"x":1,"y":2},"button":"left","clickCount":1,"target":{"role":"AXTextField","subrole":"AXSecureTextField","value":"secure-click-value","isSecure":false},"dom":{"selector":"[value='secure-click-value']","name":"secure-click-value"}}"#
    let unsafeEvent = try JSONDecoder.replay.decode(
        CapturedEvent.self,
        from: Data(unsafeJSON.utf8)
    )

    try await writer.append(unsafeEvent)
    try await writer.finish()

    let contents = try String(
        contentsOf: directory.appendingPathComponent("events.jsonl"),
        encoding: .utf8
    )
    #expect(!contents.contains(secret))
    #expect(contents.contains(Redaction.marker))

    let persisted = try JSONDecoder.replay.decode(
        CapturedEvent.self,
        from: Data(contents.split(separator: "\n")[0].utf8)
    )
    #expect(persisted.target?.isSecure == true)
    #expect(persisted.dom == nil)
}

private func makeTemporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("ReplayCaptureTests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

private func createUnfinishedSession(at directory: URL) async throws {
    let writer = try await SessionWriter.create(configuration: .init(
        sessionId: "session-1",
        directory: directory,
        includeAudio: false,
        display: .init(width: 100, height: 50, scale: 1)
    ))
    await writer.closeForTestingWithoutFinalizing()
}

private func makeStructurallyValidRecoveryVideo() -> Data {
    var handler = Data(repeating: 0, count: 8)
    handler.append(contentsOf: "vide".utf8)
    handler.append(Data(repeating: 0, count: 12))

    var visualSampleEntry = Data(repeating: 0, count: 78)
    visualSampleEntry.append(mediaBox(
        "avcC",
        payload: Data([1, 100, 0, 40, 0xFF, 0xE1, 0])
    ))
    var sampleDescription = Data(repeating: 0, count: 4)
    sampleDescription.append(bigEndianData(1))
    sampleDescription.append(mediaBox("avc1", payload: visualSampleEntry))

    let sampleTable = mediaBox(
        "stbl",
        payload: mediaBox("stsd", payload: sampleDescription)
    )
    let mediaInfo = mediaBox("minf", payload: sampleTable)
    let media = mediaBox(
        "mdia",
        payload: mediaBox("hdlr", payload: handler) + mediaInfo
    )
    let movie = mediaBox(
        "moov",
        payload: mediaBox("mvhd", payload: Data(repeating: 0, count: 20))
            + mediaBox("trak", payload: media)
    )
    return mediaBox("mdat", payload: Data([0, 0, 0, 1, 0x65])) + movie
}

private func mediaBox(_ type: String, payload: Data) -> Data {
    precondition(type.utf8.count == 4)
    var data = bigEndianData(UInt32(payload.count + 8))
    data.append(contentsOf: type.utf8)
    data.append(payload)
    return data
}

private func bigEndianData(_ value: UInt32) -> Data {
    Data([
        UInt8((value >> 24) & 0xFF),
        UInt8((value >> 16) & 0xFF),
        UInt8((value >> 8) & 0xFF),
        UInt8(value & 0xFF)
    ])
}

private func loadMetadata(_ directory: URL) throws -> SessionMetadata {
    try JSONDecoder.replay.decode(
        SessionMetadata.self,
        from: Data(contentsOf: directory.appendingPathComponent("meta.json"))
    )
}
