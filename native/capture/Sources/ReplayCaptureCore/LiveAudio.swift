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
    ///
    /// The coordinator only ever calls this for one utterance at a time,
    /// waiting for it to return before calling it again.
    func speak(_ text: String) async -> Bool
    /// Named apart from `SpeechRecognizing.stop()` so one type can conform to
    /// both protocols without one method silently satisfying both.
    ///
    /// Requirement this relies on: the coordinator may call this for an
    /// utterance immediately before calling `speak(_:)` for that same
    /// utterance, rather than strictly after. Conforming types must still
    /// apply the stop to that utterance rather than letting the following
    /// `speak(_:)` call silently proceed as if it had never been
    /// requested — in particular, `speak(_:)` must not itself clear a stop
    /// that was already requested for the call it is about to start.
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
/// Guaranteed under actor reentrancy, each point exercised by a
/// deterministic interleaving test in `LiveAudioTests.swift` (fakes that
/// suspend until released, not fakes that always run to completion):
///
/// 1. Every utterance that is ever queued emits exactly one `started` (or
///    none, if it is refused before it is ever dequeued) followed by
///    exactly one terminal event, `finished` or `cancelled`. Never zero
///    terminal events, never two — including when `start()` itself fails
///    with utterances already queued.
/// 2. `stopSpeaking()` and `stop()` cancel whichever utterance is actually
///    in flight at the instant they are called, if any, rather than
///    letting it play to completion. This assumes calls into this actor
///    are never themselves concurrent with each other from *outside* it —
///    true because the sidecar awaits each command before reading the
///    next, so it never has two of this coordinator's methods in flight
///    at once — and it assumes `SpeechSynthesizing` conformances honour
///    the ordering requirement documented on `stopSpeaking()`. Given both,
///    a stop is never left to land on a later, unrelated utterance
///    instead.
/// 3. `setPaused(true)` stops an in-flight utterance the same way, and
///    cancels everything still queued rather than letting it start.
/// 4. A state event (`preparingModel`/`listening`/`paused`/`failed`) is
///    only sent if it is still true at the moment it is actually sent —
///    one superseded by a concurrent call while this call was suspended is
///    dropped rather than sent stale, and none at all follows `stop()`.
/// 5. `stop()` does not return until the drain loop has fully quiesced:
///    every utterance already dequeued has received its terminal event
///    before `stop()`'s caller resumes.
/// 6. Once `start()` has failed, or `stop()` has been called, the
///    coordinator permanently refuses new speech: `speak()` emits
///    `.cancelled` immediately rather than queuing, and a `start()` that
///    fails or is interrupted by a concurrent `stop()` leaves the
///    recogniser stopped, not still running.
///
/// Deliberately *not* guaranteed: transcripts are not gated by speech.
/// `ingest(_:)` only checks `paused`/`stopped`, never whether an utterance
/// is mid-flight, so transcripts keep flowing while the tutor talks — that
/// is full duplex by design (the user can barge in), not an oversight.
///
/// Mechanism for 1–3: `generation` is bumped synchronously, before any
/// `await`, at the top of `stopSpeaking()` — and so transitively by
/// `stop()` and `setPaused(true)`, which both call it with nothing awaited
/// first, so the bump happens no later than it would if they bumped it
/// themselves. Each pass of the drain loop captures `generation` at the
/// moment it dequeues an utterance, synchronously alongside the dequeue.
/// After the utterance's `started` event has actually been sent — the
/// first `await` since that capture — the loop re-checks: if `generation`
/// has changed, the utterance is cancelled without ever being handed to
/// the synthesiser, closing the window where a stop/pause that lands
/// during that `await` would otherwise be silently lost. Separately,
/// `inFlightUtteranceId` records whether an utterance has actually reached
/// `synthesiser.speak(_:)`. `stopSpeaking()` reads it synchronously, before
/// its own first `await`, to decide whether the synthesiser has anything to
/// stop — and, if so, tells it to stop before doing anything else that
/// could delay that call past the point where a later utterance has
/// already started on the synthesiser.
///
/// Mechanism for 4: every branch of `setPaused(_:)` that follows an `await`
/// re-reads `self.paused`/`stopped` and compares against the value this
/// call was asked to set, sending the event only if nothing else has since
/// changed it or stopped the coordinator entirely. `start()` does the same
/// for `listening` against `paused`/`stopped`.
///
/// Mechanism for 1 and 6's queued-utterance case: the `start()` failure
/// path sets `stopped = true` and calls `stopSpeaking()` — not just the
/// flag — before sending `failed`, so anything already queued (`speak()`
/// has no dependency on `start()` having succeeded first) is cancelled
/// rather than left stranded. `clearDrain()` also refuses to restart the
/// drain once `stopped`, which would otherwise be a second way for the
/// same utterances to be lost: without it, a queue left non-empty while
/// stopped — which should not happen given the above, but this is the
/// backstop — would have made `runDrain`'s own `!stopped` loop guard and
/// `clearDrain`'s restart fight forever, each exiting and immediately
/// re-triggering the other.
///
/// As with `queue`, every read of `generation`/`inFlightUtteranceId`/
/// `paused`/`stopped` used to decide whether to act is paired with its
/// mutation in the same await-free stretch — no `await` separates a check
/// from the state it is checking.
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
    /// Bumped, synchronously and before any `await`, by anything that means
    /// "abandon whatever speech is in flight": `stopSpeaking()`, and so
    /// transitively `stop()` and `setPaused(true)`. The drain loop compares
    /// this against the value it captured at dequeue time to notice a
    /// stop/pause that landed while it was sending `started`.
    private var generation = 0
    /// The utterance id currently inside `synthesiser.speak(_:)`, if any.
    /// Set immediately before that call and cleared immediately after it
    /// returns, so `stopSpeaking()` can tell — synchronously, before its own
    /// first `await` — whether the synthesiser actually has something to
    /// stop.
    private var inFlightUtteranceId: String?

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
            // A failed start leaves the coordinator permanently unusable:
            // `speak()`'s `!stopped` guard now refuses everything. Also
            // cancel anything already queued (speak() has no "start()
            // succeeded first" requirement, so utterances can be queued
            // while this call is still suspended above): runDrain's own
            // loop condition also checks `!stopped`, so left uncancelled
            // they could never be drained, and clearDrain would otherwise
            // restart the drain forever trying.
            stopped = true
            await stopSpeaking()
            await emit(.init(
                event: .state,
                sessionId: sessionId,
                state: .failed,
                reason: reason(for: error)
            ))
            throw error
        }
        // `stop()`/`setPaused(true)` may have already run while the await
        // above was suspended — a real recogniser can still be mid-start
        // when that happens.
        guard !stopped else {
            // stop() ran concurrently and already called recogniser.stop()
            // once, but that call landed while recogniser.start() was
            // still suspended, before a real recogniser would have had
            // anything running to stop. Tell it again now that it
            // genuinely has started.
            await recogniser.stop()
            return
        }
        guard !paused else { return }
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
        // Bump before any await: an utterance the drain loop has already
        // dequeued, but has not yet sent `synthesiser.speak(_:)` for, will
        // see this change when it re-checks after its `started` event.
        generation += 1
        // Captured now, synchronously, rather than re-derived after the
        // awaits below: that is what stops this call's synthesiser-stop
        // from drifting onto whatever the synthesiser happens to be playing
        // by the time it actually runs, which could by then be a later
        // utterance this call never intended to touch.
        let shouldStopSynthesiser = inFlightUtteranceId != nil
        let pending = queue
        queue.removeAll()
        // Told first, before the cancellation emits below (which can each
        // suspend on the event sink for a while): the sooner this reaches
        // the synthesiser, the smaller the window for a later utterance to
        // have started on it first.
        if shouldStopSynthesiser {
            await synthesiser.stopSpeaking()
        }
        for utterance in pending {
            await emit(speechEvent(utterance.id, .cancelled))
        }
    }

    public func setPaused(_ paused: Bool) async {
        guard !stopped, self.paused != paused else { return }
        self.paused = paused
        if paused {
            await stopSpeaking()
            // A concurrent setPaused(false)/setPaused(true), or stop(),
            // may have run while the await above was suspended. Only
            // report paused if that is still the current, intended state,
            // and never once stopped: stop() itself sends no state event,
            // so nothing may follow it.
            guard !stopped, self.paused == paused else { return }
            await emit(.init(event: .state, sessionId: sessionId, state: .paused))
        } else {
            // No await precedes this: the assignment above and this emit
            // are the same synchronous stretch, so the only thing that
            // could have changed `stopped` is already covered by the guard
            // at the top of this call. Re-checked anyway, so that "once
            // stopped, no state event is sent" holds at every emit site on
            // its own, not just by tracing back through the whole call.
            guard !stopped else { return }
            await emit(.init(event: .state, sessionId: sessionId, state: .listening))
        }
    }

    public func stop() async {
        stopped = true
        await stopSpeaking()
        await recogniser.stop()
        // Wait for the drain loop to actually quiesce rather than cancel
        // and forget it: by the time stop() returns, every utterance
        // already dequeued has received its terminal event.
        await drain?.value
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
        // Captured strongly, deliberately: `drain` already holds this task,
        // so a weak capture buys no cycle-breaking, and only adds a way for
        // a queued-but-not-yet-terminal utterance to be abandoned if
        // something external drops its last reference to the coordinator
        // mid-drain. Once the closure returns, the task's own capture is
        // released like any other, same as a strong capture would be.
        drain = Task {
            await self.runDrain()
            self.clearDrain()
        }
    }

    private func clearDrain() {
        drain = nil
        // Never restart once stopped: runDrain's own loop condition also
        // checks `!stopped`, so if something ever left the queue
        // non-empty while stopped (defence in depth — stopSpeaking() in
        // stop()/the failure path above should already have emptied it),
        // restarting here would just recreate a task that exits
        // immediately and asks to be restarted again, forever.
        if !queue.isEmpty, !stopped { startDrainIfNeeded() }
    }

    private func runDrain() async {
        while !queue.isEmpty, !stopped {
            let utterance = queue.removeFirst()
            let generationAtDequeue = generation
            await emit(speechEvent(utterance.id, .started))
            // A stop/pause landed while the emit above was suspended: it
            // bumped `generation` but, since this utterance had already
            // left `queue`, had nothing there left to cancel. Catch it here
            // instead of ever handing the utterance to the synthesiser.
            guard generation == generationAtDequeue else {
                await emit(speechEvent(utterance.id, .cancelled))
                continue
            }
            inFlightUtteranceId = utterance.id
            let completed = await synthesiser.speak(utterance.text)
            inFlightUtteranceId = nil
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
