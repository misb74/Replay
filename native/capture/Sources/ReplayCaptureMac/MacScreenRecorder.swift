import AVFoundation
import CoreMedia
import Foundation
import ReplayCaptureCore
import ScreenCaptureKit

enum CaptureStartOutcome: Equatable, Sendable {
    case frameAppended
    case captureFailed
    case timedOut
}

/// A capture is not ready merely because ScreenCaptureKit accepted `startCapture`.
/// The first successfully encoded frame is the durable readiness signal.
final class CaptureStartReadiness: @unchecked Sendable {
    private let lock = NSLock()
    private var outcome: CaptureStartOutcome?
    private var waiter: CheckedContinuation<CaptureStartOutcome, Never>?

    func wait(timeoutNanoseconds: UInt64) async -> CaptureStartOutcome {
        await withTaskCancellationHandler(operation: {
            await withCheckedContinuation { continuation in
                let immediate: CaptureStartOutcome? = lock.replayWithLock {
                    if let outcome { return outcome }
                    precondition(waiter == nil, "Capture readiness can only have one waiter.")
                    waiter = continuation
                    return nil
                }
                if let immediate {
                    continuation.resume(returning: immediate)
                    return
                }
                let boundedTimeout = Int(min(timeoutNanoseconds, UInt64(Int.max)))
                DispatchQueue.global(qos: .userInitiated).asyncAfter(
                    deadline: .now() + .nanoseconds(boundedTimeout)
                ) { [self] in
                    resolve(.timedOut)
                }
            }
        }, onCancel: { [self] in
            resolve(.captureFailed)
        })
    }

    func frameAppended() {
        resolve(.frameAppended)
    }

    func fail() {
        resolve(.captureFailed)
    }

    private func resolve(_ newOutcome: CaptureStartOutcome) {
        let continuation: CheckedContinuation<CaptureStartOutcome, Never>? = lock.replayWithLock {
            guard outcome == nil else { return nil }
            outcome = newOutcome
            let continuation = waiter
            waiter = nil
            return continuation
        }
        continuation?.resume(returning: newOutcome)
    }
}

public final class MacScreenRecorder: NSObject, RecordingControlling, SCStreamDelegate, SCStreamOutput, @unchecked Sendable {
    private static let firstFrameTimeoutNanoseconds: UInt64 = 3_000_000_000

    private let stateLock = NSLock()
    private let sampleQueue = DispatchQueue(label: "Replay screen samples", qos: .userInitiated)
    private var stream: SCStream?
    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var audioRecorder: AVAudioRecorder?
    private var videoURL: URL?
    private var audioURL: URL?
    private var appendFailed = false
    private var runtimeFailed = false
    private var appendedFrameCount = 0
    private var startReadiness: CaptureStartReadiness?

    public override init() {
        super.init()
    }

    public func start(configuration: RecordingStartConfiguration) async throws -> RecordingTiming {
        let running = stateLock.replayWithLock { stream != nil || writer != nil }
        guard !running else {
            throw SidecarOperationError.invalidState("Screen recording is already active.")
        }

        let content = try await SCShareableContent.excludingDesktopWindows(
            false,
            onScreenWindowsOnly: true
        )
        let display: SCDisplay?
        if let requestedId = configuration.displayId {
            display = content.displays.first(where: { $0.displayID == requestedId })
        } else {
            display = content.displays.first(where: { $0.displayID == CGMainDisplayID() })
                ?? content.displays.first
        }
        guard let display else {
            throw SidecarOperationError.captureFailed
        }

        try ensureNewPrivateOutput(configuration.videoURL)
        if let audioURL = configuration.audioURL {
            try ensureNewPrivateOutput(audioURL)
        }

        let assetWriter = try AVAssetWriter(outputURL: configuration.videoURL, fileType: .mp4)
        assetWriter.shouldOptimizeForNetworkUse = true
        // Fragmented MP4 keeps completed fragments readable if the sidecar is
        // killed before AVAssetWriter gets a normal finish call.
        assetWriter.movieFragmentInterval = CMTime(seconds: 1, preferredTimescale: 600)

        let input = AVAssetWriterInput(
            mediaType: .video,
            outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: display.width,
                AVVideoHeightKey: display.height
            ]
        )
        input.expectsMediaDataInRealTime = true
        guard assetWriter.canAdd(input) else {
            throw SidecarOperationError.captureFailed
        }
        assetWriter.add(input)
        guard assetWriter.startWriting() else {
            throw SidecarOperationError.captureFailed
        }
        try? FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: configuration.videoURL.path
        )
        let filter = SCContentFilter(
            display: display,
            excludingApplications: [],
            exceptingWindows: []
        )
        let streamConfiguration = SCStreamConfiguration()
        streamConfiguration.width = display.width
        streamConfiguration.height = display.height
        streamConfiguration.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        streamConfiguration.queueDepth = 6
        streamConfiguration.showsCursor = true
        streamConfiguration.pixelFormat = kCVPixelFormatType_32BGRA

        let captureStream = SCStream(
            filter: filter,
            configuration: streamConfiguration,
            delegate: self
        )
        do {
            try captureStream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
        } catch {
            assetWriter.cancelWriting()
            throw SidecarOperationError.captureFailed
        }

        var microphone: AVAudioRecorder?
        do {
            if let audioURL = configuration.audioURL {
                let recorder = try AVAudioRecorder(
                    url: audioURL,
                    settings: [
                        AVFormatIDKey: kAudioFormatMPEG4AAC,
                        AVSampleRateKey: 44_100,
                        AVNumberOfChannelsKey: 1,
                        AVEncoderBitRateKey: 96_000
                    ]
                )
                guard recorder.prepareToRecord() else {
                    throw SidecarOperationError.captureFailed
                }
                microphone = recorder
            }
        } catch {
            assetWriter.cancelWriting()
            throw SidecarOperationError.captureFailed
        }

        let captureOrigin = DispatchTime.now().uptimeNanoseconds
        let sourceStart = CMTime(
            seconds: Double(captureOrigin) / 1_000_000_000,
            preferredTimescale: 1_000_000_000
        )
        assetWriter.startSession(atSourceTime: sourceStart)
        if let microphone {
            guard microphone.record() else {
                assetWriter.cancelWriting()
                throw SidecarOperationError.captureFailed
            }
            if let audioURL = configuration.audioURL {
                try? FileManager.default.setAttributes(
                    [.posixPermissions: 0o600],
                    ofItemAtPath: audioURL.path
                )
            }
        }

        let readiness = CaptureStartReadiness()
        stateLock.replayWithLock {
            writer = assetWriter
            videoInput = input
            stream = captureStream
            audioRecorder = microphone
            videoURL = configuration.videoURL
            audioURL = configuration.audioURL
            appendFailed = false
            runtimeFailed = false
            appendedFrameCount = 0
            startReadiness = readiness
        }

        do {
            try await captureStream.startCapture()
        } catch {
            microphone?.stop()
            assetWriter.cancelWriting()
            clearState()
            throw SidecarOperationError.captureFailed
        }
        let startOutcome = await readiness.wait(
            timeoutNanoseconds: Self.firstFrameTimeoutNanoseconds
        )
        guard startOutcome == .frameAppended else {
            try? await captureStream.stopCapture()
            sampleQueue.sync {}
            microphone?.stop()
            input.markAsFinished()
            assetWriter.cancelWriting()
            clearState()
            if startOutcome == .timedOut {
                throw SidecarOperationError.noVideoFrames
            }
            throw SidecarOperationError.captureFailed
        }
        return RecordingTiming(captureOriginUptimeNanoseconds: captureOrigin)
    }

    public func stop() async throws {
        let snapshot: (
            SCStream?,
            AVAssetWriter?,
            AVAssetWriterInput?,
            AVAudioRecorder?,
            URL?,
            URL?,
            Bool
        ) = stateLock.replayWithLock {
            (
                self.stream,
                self.writer,
                self.videoInput,
                self.audioRecorder,
                self.videoURL,
                self.audioURL,
                self.audioURL != nil && self.audioRecorder?.isRecording != true
            )
        }
        let (
            captureStream,
            assetWriter,
            input,
            microphone,
            videoURL,
            audioURL,
            microphoneWasUnhealthy
        ) = snapshot

        guard captureStream != nil || assetWriter != nil else { return }

        var streamStopFailed = false
        if let captureStream {
            do {
                try await captureStream.stopCapture()
            } catch {
                streamStopFailed = true
            }
        }
        // Do not inspect the frame count or finish the writer until every sample
        // callback already accepted by ScreenCaptureKit has left our serial queue.
        sampleQueue.sync {}
        microphone?.stop()
        input?.markAsFinished()

        if let assetWriter, assetWriter.status == AVAssetWriter.Status.writing {
            await withCheckedContinuation { continuation in
                assetWriter.finishWriting {
                    continuation.resume()
                }
            }
        }
        let writerDidNotComplete = assetWriter.map { $0.status != .completed } ?? false
        let captureState = stateLock.replayWithLock {
            (failed: appendFailed || runtimeFailed, frameCount: appendedFrameCount)
        }
        let videoIsUsable = videoURL.map(isNonEmptyRegularFile) ?? false
        clearState()

        if let videoURL, FileManager.default.fileExists(atPath: videoURL.path) {
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: videoURL.path)
        }
        if let audioURL, FileManager.default.fileExists(atPath: audioURL.path) {
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: audioURL.path)
        }
        guard captureState.frameCount > 0 else {
            throw SidecarOperationError.noVideoFrames
        }
        if captureState.failed
            || writerDidNotComplete
            || streamStopFailed
            || microphoneWasUnhealthy
            || !videoIsUsable {
            throw SidecarOperationError.captureFailed
        }
    }

    public func isHealthy() async -> Bool {
        stateLock.replayWithLock {
            guard stream != nil, let writer else { return false }
            let microphoneHealthy = audioURL == nil || audioRecorder?.isRecording == true
            return writer.status == .writing
                && !appendFailed
                && !runtimeFailed
                && appendedFrameCount > 0
                && microphoneHealthy
        }
    }

    public func stream(_ stream: SCStream, didStopWithError error: Error) {
        let readiness: CaptureStartReadiness? = stateLock.replayWithLock {
            guard self.stream === stream else { return nil }
            runtimeFailed = true
            return startReadiness
        }
        readiness?.fail()
    }

    public func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard outputType == .screen, sampleBuffer.isValid else { return }
        guard let attachmentArray = CMSampleBufferGetSampleAttachmentsArray(
            sampleBuffer,
            createIfNecessary: false
        ) as? [[SCStreamFrameInfo: Any]],
        let attachment = attachmentArray.first,
        let statusRawValue = attachment[.status] as? Int,
        SCFrameStatus(rawValue: statusRawValue) == .complete else {
            return
        }
        let state: (AVAssetWriterInput, AVAssetWriter, CaptureStartReadiness)? = stateLock.replayWithLock {
            guard self.stream === stream,
                  let input = videoInput,
                  let writer = self.writer,
                  let readiness = startReadiness else { return nil }
            return (input, writer, readiness)
        }
        guard let (input, writer, readiness) = state else { return }
        guard writer.status == .writing, input.isReadyForMoreMediaData else { return }
        if input.append(sampleBuffer) {
            let accepted = stateLock.replayWithLock { () -> Bool in
                guard self.stream === stream else { return false }
                appendedFrameCount += 1
                return true
            }
            if accepted { readiness.frameAppended() }
        } else {
            let failed = stateLock.replayWithLock { () -> Bool in
                guard self.stream === stream else { return false }
                appendFailed = true
                return true
            }
            if failed { readiness.fail() }
        }
    }

    private func ensureNewPrivateOutput(_ url: URL) throws {
        let manager = FileManager.default
        guard !manager.fileExists(atPath: url.path) else {
            throw SessionWriterError.sessionAlreadyExists
        }
        try manager.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
    }

    private func clearState() {
        stateLock.lock()
        stream = nil
        writer = nil
        videoInput = nil
        audioRecorder = nil
        videoURL = nil
        audioURL = nil
        appendFailed = false
        runtimeFailed = false
        appendedFrameCount = 0
        startReadiness = nil
        stateLock.unlock()
    }

    private func isNonEmptyRegularFile(_ url: URL) -> Bool {
        guard let values = try? url.resourceValues(forKeys: [
            .isRegularFileKey,
            .isSymbolicLinkKey,
            .fileSizeKey
        ]) else { return false }
        return values.isRegularFile == true
            && values.isSymbolicLink != true
            && (values.fileSize ?? 0) > 0
    }
}
