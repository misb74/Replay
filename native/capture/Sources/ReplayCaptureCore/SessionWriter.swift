import Darwin
import Foundation

public struct SessionConfiguration: Equatable, Sendable {
    public var sessionId: String
    public var directory: URL
    public var includeAudio: Bool
    public var display: DisplayInfo
    public var appVersions: [String: String]

    public init(
        sessionId: String,
        directory: URL,
        includeAudio: Bool,
        display: DisplayInfo,
        appVersions: [String: String] = [:]
    ) {
        self.sessionId = sessionId
        self.directory = directory
        self.includeAudio = includeAudio
        self.display = display
        self.appVersions = appVersions
    }
}

public enum SessionStatus: String, Codable, Equatable, Sendable {
    case recording
    case completed
    case interrupted
}

public struct SessionMetadata: Codable, Equatable, Sendable {
    public var schemaVersion: Int
    public var sessionId: String
    public var status: SessionStatus
    public var partial: Bool
    public var startedAt: Date
    public var stoppedAt: Date?
    public var display: DisplayInfo
    public var narration: Bool
    public var appVersions: [String: String]
    public var eventCount: Int
    public var lastEventTimestampMs: Double?
    public var interruptionReason: String?

    public init(
        schemaVersion: Int = 1,
        sessionId: String,
        status: SessionStatus,
        partial: Bool,
        startedAt: Date,
        stoppedAt: Date? = nil,
        display: DisplayInfo,
        narration: Bool,
        appVersions: [String: String],
        eventCount: Int = 0,
        lastEventTimestampMs: Double? = nil,
        interruptionReason: String? = nil
    ) {
        self.schemaVersion = schemaVersion
        self.sessionId = sessionId
        self.status = status
        self.partial = partial
        self.startedAt = startedAt
        self.stoppedAt = stoppedAt
        self.display = display
        self.narration = narration
        self.appVersions = appVersions
        self.eventCount = eventCount
        self.lastEventTimestampMs = lastEventTimestampMs
        self.interruptionReason = interruptionReason
    }
}

public enum SessionWriterError: Error, Equatable {
    case sessionAlreadyExists
    case sessionClosed
    case wrongSession(expected: String, actual: String)
}

public actor SessionWriter {
    public static let eventsFileName = "events.jsonl"
    public static let metadataFileName = "meta.json"
    public static let videoFileName = "video.mp4"
    public static let audioFileName = "audio.m4a"

    public let configuration: SessionConfiguration
    private var metadata: SessionMetadata
    private var eventsHandle: FileHandle?

    private init(
        configuration: SessionConfiguration,
        metadata: SessionMetadata,
        eventsHandle: FileHandle
    ) {
        self.configuration = configuration
        self.metadata = metadata
        self.eventsHandle = eventsHandle
    }

    public static func create(
        configuration: SessionConfiguration,
        startedAt: Date = Date()
    ) async throws -> SessionWriter {
        let manager = FileManager.default
        try manager.createDirectory(
            at: configuration.directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try manager.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: configuration.directory.path
        )

        let eventsURL = configuration.directory.appendingPathComponent(eventsFileName)
        let metadataURL = configuration.directory.appendingPathComponent(metadataFileName)
        guard !manager.fileExists(atPath: eventsURL.path),
              !manager.fileExists(atPath: metadataURL.path) else {
            throw SessionWriterError.sessionAlreadyExists
        }

        guard manager.createFile(
            atPath: eventsURL.path,
            contents: nil,
            attributes: [.posixPermissions: 0o600]
        ) else {
            throw CocoaError(.fileWriteUnknown)
        }

        do {
            let handle = try FileHandle(forWritingTo: eventsURL)
            let metadata = SessionMetadata(
                sessionId: configuration.sessionId,
                status: .recording,
                partial: true,
                startedAt: startedAt,
                display: configuration.display,
                narration: configuration.includeAudio,
                appVersions: configuration.appVersions
            )
            let writer = SessionWriter(
                configuration: configuration,
                metadata: metadata,
                eventsHandle: handle
            )
            try await writer.persistMetadata()
            return writer
        } catch {
            try? manager.removeItem(at: eventsURL)
            throw error
        }
    }

    public func append(_ event: CapturedEvent) throws {
        guard event.sessionId == configuration.sessionId else {
            throw SessionWriterError.wrongSession(
                expected: configuration.sessionId,
                actual: event.sessionId
            )
        }
        guard let eventsHandle else {
            throw SessionWriterError.sessionClosed
        }

        let safeEvent = event.safeForPersistence()
        var data = try JSONEncoder.replay.encode(safeEvent)
        data.append(0x0A)
        try eventsHandle.write(contentsOf: data)
        try eventsHandle.synchronize()

        metadata.eventCount += 1
        metadata.lastEventTimestampMs = safeEvent.timestampMs
        try persistMetadata()
    }

    public func finish(at date: Date = Date()) throws {
        guard eventsHandle != nil else { return }
        let previousMetadata = metadata
        try closeEventsFile()
        metadata.status = .completed
        metadata.partial = false
        metadata.stoppedAt = date
        metadata.interruptionReason = nil
        do {
            try persistMetadata()
        } catch {
            // Keep the in-memory state consistent with the still-partial file
            // on disk so the caller can persist an interrupted outcome.
            metadata = previousMetadata
            throw error
        }
    }

    public func markInterrupted(
        at date: Date = Date(),
        reason: String
    ) throws {
        guard metadata.status == .recording else { return }
        if eventsHandle != nil {
            try closeEventsFile()
        }
        metadata.status = .interrupted
        metadata.partial = true
        metadata.stoppedAt = date
        metadata.interruptionReason = reason
        try persistMetadata()
    }

    public func currentMetadata() -> SessionMetadata {
        metadata
    }

    func closeForTestingWithoutFinalizing() {
        try? closeEventsFile()
    }

    private func closeEventsFile() throws {
        try eventsHandle?.synchronize()
        try eventsHandle?.close()
        eventsHandle = nil
    }

    private func persistMetadata() throws {
        let url = configuration.directory.appendingPathComponent(Self.metadataFileName)
        let data = try JSONEncoder.replay.encode(metadata)
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}

public enum SessionRecovery {
    /// Converts a session left in the recording state into an explicit partial
    /// session. JSONL records already flushed to disk remain untouched.
    @discardableResult
    public static func recoverIfNeeded(
        at directory: URL,
        recoveredAt: Date = Date()
    ) throws -> Bool {
        try recoverIfNeeded(
            at: directory,
            recoveredAt: recoveredAt,
            afterVideoValidation: {}
        )
    }

    @discardableResult
    static func recoverIfNeeded(
        at directory: URL,
        recoveredAt: Date = Date(),
        afterVideoValidation: () throws -> Void
    ) throws -> Bool {
        let metadataURL = directory.appendingPathComponent(SessionWriter.metadataFileName)
        guard FileManager.default.fileExists(atPath: metadataURL.path) else { return false }

        let data = try Data(contentsOf: metadataURL)
        var metadata = try JSONDecoder.replay.decode(SessionMetadata.self, from: data)
        guard metadata.status == .recording else { return false }

        recoverVideoIfPossible(
            in: directory,
            afterValidation: afterVideoValidation
        )

        metadata.status = .interrupted
        metadata.partial = true
        metadata.stoppedAt = recoveredAt
        metadata.interruptionReason = "sidecar_terminated"
        try JSONEncoder.replay.encode(metadata).write(to: metadataURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: metadataURL.path)
        return true
    }

    /// AVAssetWriter writes its durable movie to a private `sb-*` sibling
    /// until a normal finish moves it into place. A SIGKILL can therefore
    /// leave an empty public output beside a complete, playable sibling.
    private static func recoverVideoIfPossible(
        in directory: URL,
        afterValidation: () throws -> Void
    ) {
        do {
            let videoURL = directory.appendingPathComponent(SessionWriter.videoFileName)
            let destination = try destinationState(at: videoURL)
            guard destination != .blocked,
                  let candidates = try recoveryCandidates(in: directory),
                  candidates.count == 1,
                  let candidate = candidates.first else {
                return
            }

            let descriptor = candidate.url.path.withCString {
                Darwin.open($0, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
            }
            guard descriptor >= 0 else {
                throw currentPOSIXError()
            }
            let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            defer { try? handle.close() }

            let openedStatus = try fileStatus(for: descriptor)
            guard isRegularFile(openedStatus),
                  openedStatus.st_nlink == 1,
                  openedStatus.st_size > 0,
                  sameFile(candidate.identity, FileIdentity(openedStatus)),
                  candidate.identity.size == openedStatus.st_size,
                  AVAssetWriterRecoveryVideo.isValid(
                    fileHandle: handle,
                    byteCount: UInt64(openedStatus.st_size)
                  ) else {
                return
            }

            try afterValidation()

            // Pin validation to the opened inode, then recheck both directory
            // names. Path swaps, new candidates, and destination changes all
            // make recovery stop without publishing anything.
            guard try candidateIsStillUnique(
                in: directory,
                expected: candidate,
                expectedSize: openedStatus.st_size
            ),
            try destinationIsUnchanged(at: videoURL, expected: destination) else {
                return
            }

            // Tighten permissions through the opened descriptor so a path swap
            // cannot redirect chmod to another file.
            guard Darwin.fchmod(descriptor, mode_t(0o600)) == 0 else {
                throw currentPOSIXError()
            }
            guard try candidatePathStillNames(
                candidate,
                expectedSize: openedStatus.st_size
            ),
            try destinationIsUnchanged(at: videoURL, expected: destination) else {
                return
            }

            try atomicRename(candidate.url, to: videoURL)
            guard Darwin.fchmod(descriptor, mode_t(0o600)) == 0 else {
                throw currentPOSIXError()
            }
            guard try destinationNamesOpenedFile(
                at: videoURL,
                opened: FileIdentity(openedStatus)
            ) else {
                return
            }
        } catch {
            // Video recovery is best effort. Unsafe, unreadable, or concurrently
            // changing artifacts remain in place, while metadata is still marked
            // interrupted below.
            return
        }
    }

    private struct FileIdentity: Equatable {
        var device: UInt64
        var inode: UInt64
        var size: off_t

        init(_ status: stat) {
            device = UInt64(truncatingIfNeeded: status.st_dev)
            inode = UInt64(truncatingIfNeeded: status.st_ino)
            size = status.st_size
        }
    }

    private struct RecoveryCandidate {
        var name: String
        var url: URL
        var identity: FileIdentity
    }

    private enum DestinationState: Equatable {
        case missing
        case empty(FileIdentity)
        case blocked
    }

    private static func destinationState(at url: URL) throws -> DestinationState {
        guard let status = try fileStatus(at: url) else { return .missing }
        guard isRegularFile(status), status.st_size == 0 else { return .blocked }
        return .empty(FileIdentity(status))
    }

    private static func destinationIsUnchanged(
        at url: URL,
        expected: DestinationState
    ) throws -> Bool {
        switch (expected, try fileStatus(at: url)) {
        case (.missing, nil):
            return true
        case let (.empty(identity), status?):
            return isRegularFile(status)
                && status.st_size == 0
                && sameFile(identity, FileIdentity(status))
        default:
            return false
        }
    }

    private static func recoveryCandidates(
        in directory: URL
    ) throws -> [RecoveryCandidate]? {
        let prefix = "\(SessionWriter.videoFileName).sb-"
        var candidates: [RecoveryCandidate] = []
        for name in try FileManager.default.contentsOfDirectory(atPath: directory.path) {
            guard name.hasPrefix(prefix), name.count > prefix.count else { continue }
            let url = directory.appendingPathComponent(name)
            guard let status = try fileStatus(at: url) else { return nil }
            guard isRegularFile(status), status.st_nlink == 1, status.st_size > 0 else {
                continue
            }
            candidates.append(RecoveryCandidate(
                name: name,
                url: url,
                identity: FileIdentity(status)
            ))
        }
        return candidates
    }

    private static func candidateIsStillUnique(
        in directory: URL,
        expected: RecoveryCandidate,
        expectedSize: off_t
    ) throws -> Bool {
        guard let candidates = try recoveryCandidates(in: directory),
              candidates.count == 1,
              let candidate = candidates.first else {
            return false
        }
        return candidate.name == expected.name
            && candidate.identity.size == expectedSize
            && sameFile(candidate.identity, expected.identity)
    }

    private static func candidatePathStillNames(
        _ expected: RecoveryCandidate,
        expectedSize: off_t
    ) throws -> Bool {
        guard let status = try fileStatus(at: expected.url) else { return false }
        return isRegularFile(status)
            && status.st_nlink == 1
            && status.st_size == expectedSize
            && sameFile(expected.identity, FileIdentity(status))
    }

    private static func destinationNamesOpenedFile(
        at url: URL,
        opened: FileIdentity
    ) throws -> Bool {
        guard let status = try fileStatus(at: url) else { return false }
        return isRegularFile(status)
            && status.st_nlink == 1
            && status.st_size == opened.size
            && sameFile(opened, FileIdentity(status))
            && (status.st_mode & mode_t(0o777)) == mode_t(0o600)
    }

    private static func fileStatus(at url: URL) throws -> stat? {
        var status = stat()
        let result = url.path.withCString { Darwin.lstat($0, &status) }
        if result == 0 { return status }
        let errorNumber = errno
        if errorNumber == ENOENT { return nil }
        throw posixError(errorNumber)
    }

    private static func fileStatus(for descriptor: CInt) throws -> stat {
        var status = stat()
        guard Darwin.fstat(descriptor, &status) == 0 else {
            throw currentPOSIXError()
        }
        return status
    }

    private static func isRegularFile(_ status: stat) -> Bool {
        (status.st_mode & S_IFMT) == S_IFREG
    }

    private static func sameFile(_ lhs: FileIdentity, _ rhs: FileIdentity) -> Bool {
        lhs.device == rhs.device && lhs.inode == rhs.inode
    }

    private static func atomicRename(_ source: URL, to destination: URL) throws {
        let result = source.path.withCString { sourcePath in
            destination.path.withCString { destinationPath in
                Darwin.rename(sourcePath, destinationPath)
            }
        }
        guard result == 0 else {
            throw currentPOSIXError()
        }
    }

    private static func currentPOSIXError() -> POSIXError {
        posixError(errno)
    }

    private static func posixError(_ errorNumber: CInt) -> POSIXError {
        POSIXError(POSIXErrorCode(rawValue: errorNumber) ?? .EIO)
    }
}

private struct MediaBox {
    var type: UInt32
    var payloadStart: UInt64
    var end: UInt64

    var payloadLength: UInt64 {
        end - payloadStart
    }
}

/// Performs bounded structural validation of the QuickTime/MP4 file that
/// AVAssetWriter leaves behind. The `sb-*` file seen after SIGKILL has no
/// `ftyp`: it starts with `mdat`, followed by `moov` and fragmented media.
private enum AVAssetWriterRecoveryVideo {
    private enum BoxType {
        static let ftyp: UInt32 = 0x6674_7970
        static let mdat: UInt32 = 0x6D64_6174
        static let moov: UInt32 = 0x6D6F_6F76
        static let mvhd: UInt32 = 0x6D76_6864
        static let trak: UInt32 = 0x7472_616B
        static let mdia: UInt32 = 0x6D64_6961
        static let hdlr: UInt32 = 0x6864_6C72
        static let vide: UInt32 = 0x7669_6465
        static let minf: UInt32 = 0x6D69_6E66
        static let stbl: UInt32 = 0x7374_626C
        static let stsd: UInt32 = 0x7374_7364
        static let avc1: UInt32 = 0x6176_6331
        static let avc3: UInt32 = 0x6176_6333
        static let avcC: UInt32 = 0x6176_6343
    }

    private static let maximumBoxCount = 100_000

    static func isValid(fileHandle handle: FileHandle, byteCount: UInt64) -> Bool {
        do {
            guard byteCount >= 24 else { return false }
            let fileEnd = byteCount
            guard let topLevel = try boxes(
                in: 0..<fileEnd,
                from: handle,
                allowingFinalMediaDataToEnd: true
            ),
            topLevel.first?.type == BoxType.ftyp || topLevel.first?.type == BoxType.mdat,
            topLevel.filter({ $0.type == BoxType.moov }).count == 1,
            topLevel.contains(where: {
                $0.type == BoxType.mdat && $0.payloadLength > 0
            }),
            let movie = topLevel.first(where: { $0.type == BoxType.moov }) else {
                return false
            }
            return try containsExpectedVideoTrack(in: movie, from: handle)
        } catch {
            return false
        }
    }

    private static func containsExpectedVideoTrack(
        in movie: MediaBox,
        from handle: FileHandle
    ) throws -> Bool {
        guard let movieChildren = try boxes(
            in: movie.payloadStart..<movie.end,
            from: handle
        ),
        movieChildren.contains(where: {
            $0.type == BoxType.mvhd && $0.payloadLength >= 20
        }) else {
            return false
        }

        for track in movieChildren where track.type == BoxType.trak {
            if try isExpectedVideoTrack(track, from: handle) {
                return true
            }
        }
        return false
    }

    private static func isExpectedVideoTrack(
        _ track: MediaBox,
        from handle: FileHandle
    ) throws -> Bool {
        guard let trackChildren = try boxes(
            in: track.payloadStart..<track.end,
            from: handle
        ) else {
            return false
        }

        for media in trackChildren where media.type == BoxType.mdia {
            guard let mediaChildren = try boxes(
                in: media.payloadStart..<media.end,
                from: handle
            ),
            let handler = mediaChildren.first(where: { $0.type == BoxType.hdlr }),
            handler.payloadLength >= 12,
            try readUInt32(at: handler.payloadStart + 8, from: handle) == BoxType.vide else {
                continue
            }

            for mediaInfo in mediaChildren where mediaInfo.type == BoxType.minf {
                if try containsH264SampleDescription(in: mediaInfo, from: handle) {
                    return true
                }
            }
        }
        return false
    }

    private static func containsH264SampleDescription(
        in mediaInfo: MediaBox,
        from handle: FileHandle
    ) throws -> Bool {
        guard let mediaInfoChildren = try boxes(
            in: mediaInfo.payloadStart..<mediaInfo.end,
            from: handle
        ) else {
            return false
        }

        for sampleTable in mediaInfoChildren where sampleTable.type == BoxType.stbl {
            guard let sampleTableChildren = try boxes(
                in: sampleTable.payloadStart..<sampleTable.end,
                from: handle
            ) else {
                continue
            }
            for description in sampleTableChildren where description.type == BoxType.stsd {
                if try containsH264Entry(in: description, from: handle) {
                    return true
                }
            }
        }
        return false
    }

    private static func containsH264Entry(
        in description: MediaBox,
        from handle: FileHandle
    ) throws -> Bool {
        guard description.payloadLength >= 8,
              let prefix = try readExactly(
                8,
                at: description.payloadStart,
                from: handle
              ) else {
            return false
        }
        let declaredEntryCount = Int(readUInt32(from: prefix, at: 4))
        guard declaredEntryCount > 0, declaredEntryCount <= 64,
              let entries = try boxes(
                in: (description.payloadStart + 8)..<description.end,
                from: handle
              ),
              entries.count == declaredEntryCount else {
            return false
        }

        for entry in entries where entry.type == BoxType.avc1 || entry.type == BoxType.avc3 {
            // A VisualSampleEntry has 78 bytes before its codec-specific boxes.
            let codecBoxesStart = entry.payloadStart + 78
            guard codecBoxesStart <= entry.end,
                  let codecBoxes = try boxes(
                    in: codecBoxesStart..<entry.end,
                    from: handle
                  ),
                  let configuration = codecBoxes.first(where: {
                    $0.type == BoxType.avcC && $0.payloadLength >= 7
                  }),
                  let version = try readExactly(
                    1,
                    at: configuration.payloadStart,
                    from: handle
                  )?.first,
                  version == 1 else {
                continue
            }
            return true
        }
        return false
    }

    private static func boxes(
        in range: Range<UInt64>,
        from handle: FileHandle,
        allowingFinalMediaDataToEnd: Bool = false
    ) throws -> [MediaBox]? {
        guard range.lowerBound <= range.upperBound else { return nil }
        var parsed: [MediaBox] = []
        var offset = range.lowerBound

        while offset < range.upperBound {
            guard parsed.count < maximumBoxCount,
                  range.upperBound - offset >= 8,
                  let header = try readExactly(8, at: offset, from: handle) else {
                return nil
            }
            let shortSize = readUInt32(from: header, at: 0)
            let type = readUInt32(from: header, at: 4)
            var headerLength: UInt64 = 8
            let boxLength: UInt64

            if shortSize == 1 {
                guard range.upperBound - offset >= 16,
                      let extendedSize = try readExactly(8, at: offset + 8, from: handle) else {
                    return nil
                }
                headerLength = 16
                boxLength = readUInt64(from: extendedSize, at: 0)
            } else if shortSize == 0 {
                guard allowingFinalMediaDataToEnd, type == BoxType.mdat else {
                    return nil
                }
                boxLength = range.upperBound - offset
            } else {
                boxLength = UInt64(shortSize)
            }

            guard boxLength >= headerLength,
                  boxLength <= range.upperBound - offset else {
                return nil
            }
            let end = offset + boxLength
            parsed.append(MediaBox(
                type: type,
                payloadStart: offset + headerLength,
                end: end
            ))
            offset = end
        }
        return parsed
    }

    private static func readUInt32(
        at offset: UInt64,
        from handle: FileHandle
    ) throws -> UInt32? {
        guard let data = try readExactly(4, at: offset, from: handle) else { return nil }
        return readUInt32(from: data, at: 0)
    }

    private static func readExactly(
        _ count: Int,
        at offset: UInt64,
        from handle: FileHandle
    ) throws -> Data? {
        try handle.seek(toOffset: offset)
        guard let data = try handle.read(upToCount: count), data.count == count else {
            return nil
        }
        return data
    }

    private static func readUInt32(from data: Data, at offset: Int) -> UInt32 {
        data[offset..<(offset + 4)].reduce(UInt32(0)) { value, byte in
            (value << 8) | UInt32(byte)
        }
    }

    private static func readUInt64(from data: Data, at offset: Int) -> UInt64 {
        data[offset..<(offset + 8)].reduce(UInt64(0)) { value, byte in
            (value << 8) | UInt64(byte)
        }
    }
}
