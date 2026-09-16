import Foundation

/// One recognised piece of speech. Times are host uptime nanoseconds so the
/// coordinator can express them on the same clock as captured input events.
public struct RecognisedSegment: Equatable, Sendable {
    public var segmentId: String
    public var text: String
    public var isFinal: Bool
    public var startNanoseconds: UInt64
    public var endNanoseconds: UInt64

    public init(
        segmentId: String,
        text: String,
        isFinal: Bool,
        startNanoseconds: UInt64,
        endNanoseconds: UInt64
    ) {
        self.segmentId = segmentId
        self.text = text
        self.isFinal = isFinal
        self.startNanoseconds = startNanoseconds
        self.endNanoseconds = endNanoseconds
    }
}

public protocol SpeechRecognizing: AnyObject, Sendable {
    func start(handler: @escaping @Sendable (RecognisedSegment) async -> Void) async throws
    func stop() async
}

public protocol SpeechSynthesizing: AnyObject, Sendable {
    /// Speaks one utterance. Returns true when it played to completion and
    /// false when it was stopped.
    func speak(_ text: String) async -> Bool
    /// Named apart from `SpeechRecognizing.stop()` so one type can conform to
    /// both protocols without one method silently satisfying both.
    func stopSpeaking() async
}

public struct LiveAudioStartConfiguration: Equatable, Sendable {
    public var sessionId: String
    public var audioURL: URL
    public var locale: String?
    public var captureOriginUptimeNanoseconds: UInt64

    public init(
        sessionId: String,
        audioURL: URL,
        locale: String?,
        captureOriginUptimeNanoseconds: UInt64
    ) {
        self.sessionId = sessionId
        self.audioURL = audioURL
        self.locale = locale
        self.captureOriginUptimeNanoseconds = captureOriginUptimeNanoseconds
    }
}

public protocol LiveAudioControlling: AnyObject, Sendable {
    func speak(utteranceId: String, text: String) async
    func stopSpeaking() async
    func setPaused(_ paused: Bool) async
    func stop() async
}

/// Creates a live audio session. The sidecar holds one of these only on a
/// system new enough to run on-device streaming speech.
public protocol LiveAudioProviding: AnyObject, Sendable {
    func makeSession(
        configuration: LiveAudioStartConfiguration,
        eventSink: @escaping @Sendable (SidecarLiveEventEnvelope) async -> Void
    ) async throws -> LiveAudioControlling
}

/// Owns the speech queue, the pause gate, and the conversion from host uptime
/// to capture-relative milliseconds. It knows nothing about audio hardware.
///
/// Reentrancy: every mutation of `queue` (append, removeFirst, removeAll) is
/// synchronous — never separated from the check that guards it by an
/// `await`. That is what keeps the drain loop, `stopSpeaking()`, and
/// `setPaused(_:)` safe to run interleaved: an utterance is only ever in one
/// of "still queued" (covered by `stopSpeaking()`'s cancellation loop) or
/// "already dequeued by the drain loop" (covered solely by the drain loop's
/// own terminal emit), never both, so it is impossible for two code paths to
/// race to emit its terminal event.
public actor LiveAudioCoordinator: LiveAudioControlling {
    private struct QueuedUtterance {
        let id: String
        let text: String
    }

    private let sessionId: String
    private let captureOriginUptimeNanoseconds: UInt64
    private let recogniser: SpeechRecognizing
    private let synthesiser: SpeechSynthesizing
    private let eventSink: @Sendable (SidecarLiveEventEnvelope) async -> Void
    private var queue: [QueuedUtterance] = []
    private var drain: Task<Void, Never>?
    private var paused = false
    private var stopped = false

    public init(
        sessionId: String,
        captureOriginUptimeNanoseconds: UInt64,
        recogniser: SpeechRecognizing,
        synthesiser: SpeechSynthesizing,
        eventSink: @escaping @Sendable (SidecarLiveEventEnvelope) async -> Void
    ) {
        self.sessionId = sessionId
        self.captureOriginUptimeNanoseconds = captureOriginUptimeNanoseconds
        self.recogniser = recogniser
        self.synthesiser = synthesiser
        self.eventSink = eventSink
    }

    public func start() async throws {
        await emit(.init(event: .state, sessionId: sessionId, state: .preparingModel))
        do {
            try await recogniser.start { [weak self] segment in
                await self?.ingest(segment)
            }
        } catch {
            await emit(.init(
                event: .state,
                sessionId: sessionId,
                state: .failed,
                reason: reason(for: error)
            ))
            throw error
        }
        await emit(.init(event: .state, sessionId: sessionId, state: .listening))
    }

    public func speak(utteranceId: String, text: String) async {
        guard !stopped, !paused else {
            await emit(speechEvent(utteranceId, .cancelled))
            return
        }
        queue.append(.init(id: utteranceId, text: text))
        startDrainIfNeeded()
    }

    public func stopSpeaking() async {
        let pending = queue
        queue.removeAll()
        for utterance in pending {
            await emit(speechEvent(utterance.id, .cancelled))
        }
        await synthesiser.stopSpeaking()
    }

    public func setPaused(_ paused: Bool) async {
        guard self.paused != paused else { return }
        self.paused = paused
        if paused {
            await stopSpeaking()
            await emit(.init(event: .state, sessionId: sessionId, state: .paused))
        } else {
            await emit(.init(event: .state, sessionId: sessionId, state: .listening))
        }
    }

    public func stop() async {
        stopped = true
        await stopSpeaking()
        await recogniser.stop()
        drain?.cancel()
        drain = nil
    }

    /// Waits for the speech queue to empty. Tests only.
    public func drainForTesting() async {
        await drain?.value
    }

    private func ingest(_ segment: RecognisedSegment) async {
        guard !paused, !stopped else { return }
        await emit(.init(
            event: .transcript,
            sessionId: sessionId,
            segmentId: segment.segmentId,
            text: segment.text,
            isFinal: segment.isFinal,
            startMs: milliseconds(since: segment.startNanoseconds),
            endMs: milliseconds(since: segment.endNanoseconds)
        ))
    }

    private func startDrainIfNeeded() {
        guard drain == nil else { return }
        drain = Task { [weak self] in
            await self?.runDrain()
            await self?.clearDrain()
        }
    }

    private func clearDrain() {
        drain = nil
        if !queue.isEmpty { startDrainIfNeeded() }
    }

    private func runDrain() async {
        while !queue.isEmpty, !stopped {
            let utterance = queue.removeFirst()
            await emit(speechEvent(utterance.id, .started))
            let completed = await synthesiser.speak(utterance.text)
            await emit(speechEvent(utterance.id, completed ? .finished : .cancelled))
        }
    }

    private func speechEvent(
        _ utteranceId: String,
        _ phase: SidecarLiveSpeechPhase
    ) -> SidecarLiveEventEnvelope {
        .init(event: .speech, sessionId: sessionId, utteranceId: utteranceId, phase: phase)
    }

    private func milliseconds(since uptimeNanoseconds: UInt64) -> Double {
        guard uptimeNanoseconds > captureOriginUptimeNanoseconds else { return 0 }
        return Double(uptimeNanoseconds - captureOriginUptimeNanoseconds) / 1_000_000
    }

    private func reason(for error: Error) -> String {
        guard let operationError = error as? SidecarOperationError else { return "live_audio_failed" }
        switch operationError {
        case .permissionDenied: return "permission_denied"
        case .captureFailed: return "capture_failed"
        case .ioFailed: return "io_failed"
        default: return "live_audio_failed"
        }
    }

    private func emit(_ envelope: SidecarLiveEventEnvelope) async {
        await eventSink(envelope)
    }
}
