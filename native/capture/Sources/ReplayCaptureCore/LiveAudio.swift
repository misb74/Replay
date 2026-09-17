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
    /// May be called before `start()` has returned, more than once, and
    /// concurrently with itself (including with another `stop()` call
    /// already in flight — the coordinator's own failure path and its
    /// public `stop()` can both end up calling this for the same reason at
    /// once). Conformances must be idempotent: any number of calls, in any
    /// of those ways, must leave the recogniser not running, and must not
    /// crash or corrupt its state.
    func stop() async
}

public protocol SpeechSynthesizing: AnyObject, Sendable {
    /// Speaks one utterance, identified by `utteranceId`. Returns true when
    /// it played to completion and false when it was stopped.
    ///
    /// What callers guarantee, which conformances may rely on:
    /// - An utterance id is never reused.
    /// - `speak(_:utteranceId:)` is never called while an earlier call has
    ///   not yet returned. The coordinator speaks one utterance at a time.
    ///
    /// Registering an utterance forgets every id this synthesiser was
    /// holding a stop for (see `stopSpeaking(utteranceId:)`). Each of those
    /// names an utterance whose own `speak(_:utteranceId:)` has already
    /// returned — including one that finished on its own just before its
    /// stop arrived — so, ids never being reused, nothing can ever claim
    /// them. Forgetting them is what keeps the remembered set from growing
    /// for the life of the session.
    func speak(_ text: String, utteranceId: String) async -> Bool
    /// Stops the utterance named by `utteranceId`. Named apart from
    /// `SpeechRecognizing.stop()` so one type can conform to both
    /// protocols without one method silently satisfying both.
    ///
    /// Required semantics:
    /// - If `utteranceId` is the utterance currently playing, it stops,
    ///   and its `speak(_:utteranceId:)` call returns false.
    /// - Otherwise the stop is remembered for that id alone: a later
    ///   `speak(_:utteranceId:)` call for the same id returns false
    ///   immediately, without playing. This covers both a stop that
    ///   overtook its own `speak(_:utteranceId:)` call and one that
    ///   arrived after its utterance had already finished — which look
    ///   the same from here, and which the second is harmless for,
    ///   because that id will never be spoken again and the next
    ///   utterance to register forgets it.
    /// - Either way, a stop never affects an utterance it did not name.
    ///
    /// Scoping this by id, rather than a single global "a stop was
    /// requested" flag, is what lets the coordinator target exactly the
    /// utterance it means to stop — including across the unavoidable gap
    /// between deciding to stop it and that call actually reaching the
    /// synthesiser — without a stop that arrives just after its target
    /// already finished being misapplied to a completely different, later
    /// utterance a global flag could not tell apart from its intended one.
    func stopSpeaking(utteranceId: String) async
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

/// Outcome of asking a `LiveAudioProviding` to prepare its on-device speech
/// model. See `LiveAudioProviding.prepare(locale:)`.
public enum LivePreparation: Equatable, Sendable {
    case ready
    case preparing
}

/// Creates a live audio session. The sidecar holds one of these only on a
/// system new enough to run on-device streaming speech.
public protocol LiveAudioProviding: AnyObject, Sendable {
    /// Prepares the on-device speech model for `locale` without blocking on
    /// a first-run download.
    ///
    /// - Returns `.ready` when the on-device speech model for `locale` is
    ///   installed. A nil `locale` means the system locale.
    /// - Otherwise it starts installing the model in the background and
    ///   returns `.preparing` without waiting. There is at most one
    ///   installation per locale at a time, however often `prepare` is
    ///   called; a later call joins the running one.
    /// - It throws when the locale is unsupported, or when the most recent
    ///   installation failed. A failure is reported once; the call after
    ///   that starts a fresh installation.
    func prepare(locale: String?) async throws -> LivePreparation

    func makeSession(
        configuration: LiveAudioStartConfiguration,
        eventSink: @escaping @Sendable (SidecarLiveEventEnvelope) async -> Void
    ) async throws -> LiveAudioControlling
}

/// Owns the speech queue, the pause gate, and the conversion from host uptime
/// to capture-relative milliseconds. It knows nothing about audio hardware.
/// Every speech event it sends carries that conversion's result as `atMs`,
/// read at the moment its phase was decided.
///
/// Guaranteed under actor reentrancy, and — where noted — under a
/// scheduling race that reentrancy alone cannot rule out. Each point below
/// has a deterministic interleaving test in `LiveAudioTests.swift` (fakes
/// that suspend until released, not fakes that always run to completion):
///
/// 1. Every utterance that is ever queued emits exactly one `started` (or
///    none, if it is refused before it is ever dequeued) followed by
///    exactly one terminal event, `finished` or `cancelled`. Never zero
///    terminal events, never two — including when `start()` itself fails
///    with utterances already queued.
/// 2. `stopSpeaking()` and `stop()` cancel whichever utterance is actually
///    in flight at the instant they are called, if any, rather than
///    letting it play to completion, and never land on a later, unrelated
///    utterance instead. The second half holds even under a scheduling
///    race actor isolation does not rule out — see "Targeted stop" below
///    — because it does not depend on this coordinator's own methods
///    never being called concurrently with each other; it depends only on
///    `SpeechSynthesizing` conformances honouring the per-id contract
///    documented on `stopSpeaking(utteranceId:)`.
/// 3. `setPaused(true)` stops an in-flight utterance the same way, and
///    cancels everything still queued — including an utterance queued but
///    not yet dequeued when the pause lands — rather than letting it
///    start.
/// 4. A state event (`preparingModel`/`listening`/`paused`/`failed`) is
///    only sent if it is still true at the moment it is actually sent —
///    one superseded by a concurrent call while this call was suspended is
///    dropped rather than sent stale, and none at all follows `stop()`,
///    including a `failed` from a `start()` that `stop()` interrupted or
///    from a `reportFailure(reason:)` that landed after it.
/// 5. `stop()` does not return until the drain loop has fully quiesced:
///    every utterance already dequeued has received its terminal event
///    before `stop()`'s caller resumes. `start()`'s failure path does the
///    same before it throws.
/// 6. Once `start()` has failed, a failure has been reported through
///    `reportFailure(reason:)`, or `stop()` has been called, the
///    coordinator permanently refuses new speech: `speak()` emits
///    `.cancelled` immediately rather than queuing, and the recogniser is
///    left stopped, not still running, in every case. A later
///    `setPaused(false)` does not resurrect it.
/// 7. Exactly one `failed` is ever sent, whichever of the two failure
///    paths gets there first and however often `reportFailure(reason:)`
///    is called — and only after every utterance's terminal event, never
///    before.
///
/// Deliberately *not* guaranteed: transcripts are not gated by speech.
/// `ingest(_:)` only checks `paused`/`stopped`, never whether an utterance
/// is mid-flight, so transcripts keep flowing while the tutor talks — that
/// is full duplex by design (the user can barge in), not an oversight.
///
/// Targeted stop (mechanism for 2's "never land on a later utterance").
/// `stopSpeaking()` passes `inFlightUtteranceId`, captured synchronously
/// before its own first `await`, as the id
/// `synthesiser.stopSpeaking(utteranceId:)` names. Naming the id is what
/// makes this correct under timing this actor's own isolation cannot
/// control: resuming from `synthesiser.speak(_:utteranceId:)` — for
/// example because the utterance finished on its own — is itself a
/// scheduling event, not guaranteed to run before some other, already
/// ready job on this actor, so a stop decided while that utterance was
/// still in flight can still reach the synthesiser after it has already
/// finished. Untargeted, that stale stop would have nothing of its own
/// left to apply to and, under the requirement the previous round of this
/// task placed on `speak(_:)`, would have been held and wrongly applied to
/// whatever later, unrelated utterance spoke next — the actual defect
/// that requirement introduced (round 2 of this task's report has the
/// probe evidence). Named, the same stale stop instead targets a specific
/// id that has already finished, which `stopSpeaking(utteranceId:)`'s
/// contract defines as having no effect, so it cannot land on anything
/// else. `stopSpeaking()` still tells the synthesiser first, before the
/// slower per-item cancellation emits below it, which remains worth doing
/// (it shortens the window during which a real synthesiser is still
/// audibly playing something the coordinator has already decided to stop)
/// — it is just no longer what correctness depends on.
///
/// Mechanism for 1 and 3: `generation` is bumped synchronously, before any
/// `await`, at the top of `stopSpeaking()` — and so transitively by
/// `stop()` and `setPaused(true)`, which both call it with nothing awaited
/// first, so the bump happens no later than it would if they bumped it
/// themselves. `stopSpeaking()` also snapshots and clears `queue` in that
/// same stretch, which is what covers an utterance still queued, not yet
/// dequeued, when the call lands. Each pass of the drain loop separately
/// captures `generation` at the moment it dequeues an utterance,
/// synchronously alongside the dequeue. After the utterance's `started`
/// event has actually been sent — the first `await` since that capture —
/// the loop re-checks: if `generation` has changed, the utterance is
/// cancelled without ever being handed to the synthesiser, closing the
/// window where a stop/pause that lands during that `await` would
/// otherwise be silently lost.
///
/// Mechanism for 4: every branch of `setPaused(_:)` that follows an `await`
/// re-reads `self.paused`/`stopped` and compares against the value this
/// call was asked to set, sending the event only if nothing else has since
/// changed it or stopped the coordinator entirely. `start()` does the same
/// for `listening` against `paused`/`stopped`, and for `failed` against a
/// separate `stopCalled` flag, set only inside `stop()`: both failure
/// paths set `stopped` themselves, so `stopped` alone cannot tell "did
/// `stop()` run" from "did sending `failed` set this".
///
/// Mechanism for 1, 5, 6's failure-path cases and 7: both failure paths —
/// `start()`'s own and `reportFailure(reason:)` — set `stopped = true`
/// synchronously and then run the one shared
/// `tearDownAndReportFailure(reason:)`, which calls `stopSpeaking()` — not
/// just the flag — and `recogniser.stop()`, then awaits the drain before
/// deciding anything else, mirroring `stop()` itself (all of these may now
/// call `recogniser.stop()`, possibly concurrently — the requirement on
/// `SpeechRecognizing.stop()` covers this). Anything already queued
/// (`speak()` has no dependency on `start()` having succeeded first) is
/// cancelled rather than left stranded, and nothing is sent — `failed` or
/// otherwise — before every dequeued utterance's terminal event is. That
/// one path also checks and sets `failureReported` in a single await-free
/// stretch, which is what makes 7's "exactly one" hold when a reported
/// failure and a failing `start()` both arrive.
/// `clearDrain()` also refuses to restart the drain once `stopped`, which
/// would otherwise be a second way for the same utterances to be lost:
/// without it, a queue left non-empty while stopped — which should not
/// happen given the above, but this is the backstop — would have made
/// `runDrain`'s own `!stopped` loop guard and `clearDrain`'s restart fight
/// forever, each exiting and immediately re-triggering the other.
///
/// As with `queue`, every read of `generation`/`inFlightUtteranceId`/
/// `paused`/`stopped`/`stopCalled`/`failureReported` used to decide
/// whether to act is paired with its mutation in the same await-free
/// stretch — no `await` separates a check from the state it is checking.
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
    /// Host uptime in nanoseconds, the same clock as
    /// `captureOriginUptimeNanoseconds` and `RecognisedSegment`. Injectable
    /// so tests can script it; defaults to the real clock.
    private let now: @Sendable () -> UInt64
    private var queue: [QueuedUtterance] = []
    private var drain: Task<Void, Never>?
    private var paused = false
    private var stopped = false
    /// Set only by `stop()`, never by either failure path (both set
    /// `stopped` themselves, so `stopped` cannot answer "did `stop()`
    /// run"). Lets a failure tell whether `stop()` already tore the
    /// coordinator down and so must send no `failed` of its own.
    private var stopCalled = false
    /// Set once a `failed` has actually been sent, by whichever failure
    /// path got there first. The two can both run — a failure reported
    /// while `start()` is suspended leaves that `start()` to throw
    /// afterwards — and the panel must be told once, not twice.
    private var failureReported = false
    /// Bumped, synchronously and before any `await`, by anything that means
    /// "abandon whatever speech is in flight": `stopSpeaking()`, and so
    /// transitively `stop()` and `setPaused(true)`. The drain loop compares
    /// this against the value it captured at dequeue time to notice a
    /// stop/pause that landed while it was sending `started`.
    private var generation = 0
    /// The utterance id currently inside `synthesiser.speak(_:utteranceId:)`,
    /// if any. Set immediately before that call and cleared immediately
    /// after it returns, so `stopSpeaking()` can tell — synchronously,
    /// before its own first `await` — whether the synthesiser has
    /// something to stop, and which id to name.
    private var inFlightUtteranceId: String?

    public init(
        sessionId: String,
        captureOriginUptimeNanoseconds: UInt64,
        recogniser: SpeechRecognizing,
        synthesiser: SpeechSynthesizing,
        eventSink: @escaping @Sendable (SidecarLiveEventEnvelope) async -> Void,
        now: @escaping @Sendable () -> UInt64 = { DispatchTime.now().uptimeNanoseconds }
    ) {
        self.sessionId = sessionId
        self.captureOriginUptimeNanoseconds = captureOriginUptimeNanoseconds
        self.recogniser = recogniser
        self.synthesiser = synthesiser
        self.eventSink = eventSink
        self.now = now
    }

    public func start() async throws {
        await emit(.init(event: .state, sessionId: sessionId, state: .preparingModel))
        do {
            try await recogniser.start { [weak self] segment in
                await self?.ingest(segment)
            }
        } catch {
            // A failed start leaves the coordinator permanently unusable:
            // `speak()`'s `!stopped` guard now refuses everything. Set
            // synchronously, before the shared teardown's first await, so
            // speech is refused from the moment the failure is known.
            stopped = true
            await tearDownAndReportFailure(reason: reason(for: error))
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
            // genuinely has started — safe, since SpeechRecognizing.stop()
            // must be idempotent.
            await recogniser.stop()
            return
        }
        guard !paused else { return }
        await emit(.init(event: .state, sessionId: sessionId, state: .listening))
    }

    public func speak(utteranceId: String, text: String) async {
        guard !stopped, !paused else {
            await emit(speechEvent(utteranceId, .cancelled, atMs: nowMs()))
            return
        }
        queue.append(.init(id: utteranceId, text: text))
        startDrainIfNeeded()
    }

    public func stopSpeaking() async {
        // Bump before any await: an utterance the drain loop has already
        // dequeued, but has not yet sent `synthesiser.speak(_:utteranceId:)`
        // for, will see this change when it re-checks after its `started`
        // event.
        generation += 1
        // Captured now, synchronously, rather than re-derived after the
        // awaits below, and passed by name to the synthesiser: naming it
        // is what makes this call harmless if it ends up reaching the
        // synthesiser after this id has already finished on its own (see
        // "Targeted stop" above) — it no longer matters whether that
        // happens before or after some other, later utterance has started.
        let targetId = inFlightUtteranceId
        let pending = queue
        queue.removeAll()
        // Read now, in the same await-free stretch as clearing the queue,
        // not after the synthesiser call below: that call can suspend for a
        // while, and reading the clock after it would stamp `pending`'s
        // cancellations later than the moment this stop actually decided
        // them. Nil when there is nothing queued, so a stop that only
        // targets an in-flight utterance never reads the clock for this.
        let pendingCancelledAtMs: Double? = pending.isEmpty ? nil : nowMs()
        // Told first, before the cancellation emits below (which can each
        // suspend on the event sink for a while): still worth doing even
        // though correctness no longer depends on it — it shortens how
        // long a real synthesiser keeps audibly playing something this
        // call has already decided to stop.
        if let targetId {
            await synthesiser.stopSpeaking(utteranceId: targetId)
        }
        if let pendingCancelledAtMs {
            for utterance in pending {
                await emit(speechEvent(utterance.id, .cancelled, atMs: pendingCancelledAtMs))
            }
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
        stopCalled = true
        await stopSpeaking()
        await recogniser.stop()
        // Wait for the drain loop to actually quiesce rather than cancel
        // and forget it: by the time stop() returns, every utterance
        // already dequeued has received its terminal event.
        await drain?.value
    }

    /// Reports a failure noticed outside this coordinator — the audio
    /// route changed, the recogniser's results stream threw, the narration
    /// file could not be written — as a single `state: failed` carrying
    /// `reason`. The reason is a wire code, passed through unchanged
    /// alongside the ones `reason(for:)` produces for a failed `start()`.
    ///
    /// Does nothing at all once the coordinator has stopped, has already
    /// failed, or is tearing down after a failed `start()`: all three set
    /// `stopped`, which is read here synchronously, before any `await`, so
    /// no state event can follow `stop()` and a second failure is silent.
    /// Otherwise the tutor is torn down exactly as a failed `start()`
    /// tears it down, and a later `stop()` still works, and stays silent.
    ///
    /// Only the tutor stops. The caller is the audio engine, not the
    /// recorder: screen capture, the input monitor and the session writer
    /// know nothing of this and keep going, which is what spec §8 asks for
    /// — `audio.m4a` may simply end early.
    public func reportFailure(reason: String) async {
        guard !stopped else { return }
        stopped = true
        await tearDownAndReportFailure(reason: reason)
    }

    /// The teardown both failure paths share: `start()`'s own, and
    /// `reportFailure(reason:)`. Callers set `stopped` synchronously
    /// before calling, so speech is refused from the instant the failure
    /// is known rather than from whenever this resumes.
    ///
    /// Cancels anything already queued — `speak()` has no "start()
    /// succeeded first" requirement, so utterances can be queued while
    /// `start()` is still suspended, and an utterance can be in flight
    /// when the audio hardware gives out — and stops the recogniser. Both
    /// are idempotent and safe even if `stop()` is doing, or has done, the
    /// same thing concurrently, per the requirement documented on
    /// `SpeechRecognizing.stop()`.
    ///
    /// Then waits for the drain to quiesce before deciding anything else,
    /// mirroring `stop()`: otherwise a dequeued utterance's terminal event
    /// could still be in flight when `failed` is sent, and `runDrain`'s own
    /// `!stopped` guard plus `clearDrain`'s refusal to restart would leave
    /// nothing to make it happen.
    ///
    /// Sends nothing at all if `stop()` has run. It may have run
    /// concurrently — the `recogniser.stop()` call above, or one from a
    /// genuinely concurrent `stop()`, can itself be what made
    /// `recogniser.start()` throw, by aborting a recogniser still
    /// mid-start — and it already tore everything down and sent no state
    /// event of its own, so a stale `failed` must not follow it. Nor if
    /// the other failure path has already reported: a route change that
    /// lands while `start()` is still suspended reports first and leaves
    /// that same `start()` to throw afterwards, and the panel must be told
    /// once, not twice.
    private func tearDownAndReportFailure(reason: String) async {
        await stopSpeaking()
        await recogniser.stop()
        await drain?.value
        guard !stopCalled, !failureReported else { return }
        failureReported = true
        await emit(.init(event: .state, sessionId: sessionId, state: .failed, reason: reason))
    }

    /// Waits for the speech queue to empty. Tests only.
    public func drainForTesting() async {
        await drain?.value
    }

    /// Whether a drain task is currently registered. Tests only — lets a
    /// test confirm the drain has genuinely stopped (rather than a task
    /// existing that will just recreate itself) without inferring it
    /// indirectly from CPU usage.
    public var isDrainingForTesting: Bool { drain != nil }

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
            // Read just before the synthesiser is asked to speak: this is
            // the coordinator's decision to move on to this utterance next,
            // before any await, and so before the emit below.
            await emit(speechEvent(utterance.id, .started, atMs: nowMs()))
            // A stop/pause landed while the emit above was suspended: it
            // bumped `generation` but, since this utterance had already
            // left `queue`, had nothing there left to cancel. Catch it here
            // instead of ever handing the utterance to the synthesiser.
            guard generation == generationAtDequeue else {
                await emit(speechEvent(utterance.id, .cancelled, atMs: nowMs()))
                continue
            }
            inFlightUtteranceId = utterance.id
            let completed = await synthesiser.speak(utterance.text, utteranceId: utterance.id)
            // Read just after the synthesiser's call returns, whichever way
            // it resolved.
            let terminalAtMs = nowMs()
            inFlightUtteranceId = nil
            await emit(speechEvent(utterance.id, completed ? .finished : .cancelled, atMs: terminalAtMs))
        }
    }

    private func speechEvent(
        _ utteranceId: String,
        _ phase: SidecarLiveSpeechPhase,
        atMs: Double
    ) -> SidecarLiveEventEnvelope {
        .init(event: .speech, sessionId: sessionId, utteranceId: utteranceId, phase: phase, atMs: atMs)
    }

    private func milliseconds(since uptimeNanoseconds: UInt64) -> Double {
        guard uptimeNanoseconds > captureOriginUptimeNanoseconds else { return 0 }
        return Double(uptimeNanoseconds - captureOriginUptimeNanoseconds) / 1_000_000
    }

    /// The current moment, on the same clock and conversion as
    /// `milliseconds(since:)`.
    private func nowMs() -> Double {
        milliseconds(since: now())
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
