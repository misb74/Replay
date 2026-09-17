import Foundation
import Testing
@testable import ReplayCaptureCore

private actor EventCollector {
    private(set) var events: [SidecarLiveEventEnvelope] = []
    private var gate: (@Sendable (SidecarLiveEventEnvelope) -> Bool)?
    private var held: [CheckedContinuation<Void, Never>] = []

    func record(_ event: SidecarLiveEventEnvelope) async {
        events.append(event)
        if let gate, gate(event) {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                held.append(continuation)
            }
        }
    }

    /// Holds any future `record(_:)` whose event matches `predicate` until
    /// `release()` is called, so a test can suspend the coordinator at a
    /// precise point in its own event stream and drive an interleaving
    /// deterministically instead of racing it.
    func setGate(_ predicate: (@Sendable (SidecarLiveEventEnvelope) -> Bool)?) {
        gate = predicate
    }

    var heldCount: Int { held.count }

    func release() {
        let toRelease = held
        held.removeAll()
        gate = nil
        for continuation in toRelease { continuation.resume() }
    }

    nonisolated var sink: @Sendable (SidecarLiveEventEnvelope) async -> Void {
        { event in await self.record(event) }
    }
}

/// An honestly Sendable fake: an actor, not a class with `@unchecked
/// Sendable` and unguarded mutable state. `holdsStart` lets a test suspend
/// `start()` at will, to drive interleavings with `stop()`/`setPaused(_:)`
/// that land while a real recogniser would still be starting up.
private actor FakeRecogniser: SpeechRecognizing {
    private var handler: (@Sendable (RecognisedSegment) async -> Void)?
    private let startError: Error?
    private let holdsStart: Bool
    private var startContinuation: CheckedContinuation<Void, Never>?
    private(set) var stopCallCount = 0
    /// Models whether a real recogniser would currently be running: set
    /// once `start()` actually completes (after any hold), cleared by
    /// `stop()`. Lets a test tell "stop() was called" apart from "the
    /// recogniser is actually stopped".
    private(set) var running = false

    var isHoldingStart: Bool { startContinuation != nil }

    init(startError: Error? = nil, holdsStart: Bool = false) {
        self.startError = startError
        self.holdsStart = holdsStart
    }

    func start(handler: @escaping @Sendable (RecognisedSegment) async -> Void) async throws {
        if holdsStart {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                startContinuation = continuation
            }
        }
        if let startError { throw startError }
        self.handler = handler
        running = true
    }

    func releaseStart() {
        startContinuation?.resume()
        startContinuation = nil
    }

    func stop() async {
        stopCallCount += 1
        running = false
    }

    func emit(_ segment: RecognisedSegment) async {
        await handler?(segment)
    }
}

/// A synthesiser fake whose `speak(_:utteranceId:)` suspends until the test
/// releases it (`finishCurrent()`/`stopSpeaking(utteranceId:)`) rather than
/// always running to completion, and which implements the targeted-stop
/// contract required by `SpeechSynthesizing.stopSpeaking(utteranceId:)`'s
/// doc comment: a stop names the utterance it targets, only affects that
/// id, and is remembered (per id, not globally) if that id has not spoken
/// yet. `autoCompletes` (on by default) makes `speak(_:utteranceId:)`
/// return `true` immediately instead, for tests that only care about
/// ordering, not about driving a specific interleaving.
private actor FakeSynthesiser: SpeechSynthesizing {
    private(set) var spoken: [String] = []
    private(set) var stopCallCount = 0
    private var current: (id: String, continuation: CheckedContinuation<Bool, Never>)?
    private var autoCompletes = true
    private var holdStops = false
    private var heldStop: CheckedContinuation<Void, Never>?
    /// Ids stopped before their `speak(_:utteranceId:)` call registered.
    /// Scoped per id, unlike round 2's single global flag: a stop
    /// remembered for one id can never be misapplied to a later, unrelated
    /// one, even if it is never claimed (an id that has already finished
    /// is never spoken again, so an entry left over for it is harmless).
    private var pendingStopIds: Set<String> = []

    var isSpeaking: Bool { current != nil }

    func setAutoCompletes(_ value: Bool) {
        autoCompletes = value
    }

    /// Makes the *next* `stopSpeaking(utteranceId:)` call suspend after it
    /// is entered (so a test can observe that it was called before letting
    /// it actually resolve anything), released by `releaseHeldStop()`. One
    /// shot, not sticky: a second, later `stopSpeaking(utteranceId:)` call
    /// (e.g. from `stop()` racing a held `setPaused(true)`) proceeds
    /// normally rather than overwriting the first call's still-held
    /// continuation.
    func setHoldStops(_ hold: Bool) {
        holdStops = hold
    }

    func speak(_ text: String, utteranceId: String) async -> Bool {
        spoken.append(text)
        if pendingStopIds.remove(utteranceId) != nil {
            return false
        }
        if autoCompletes { return true }
        return await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            current = (utteranceId, continuation)
        }
    }

    func finishCurrent() {
        if let c = current {
            current = nil
            c.continuation.resume(returning: true)
        }
    }

    func stopSpeaking(utteranceId: String) async {
        stopCallCount += 1
        if holdStops {
            holdStops = false
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                heldStop = continuation
            }
        }
        if let c = current, c.id == utteranceId {
            current = nil
            c.continuation.resume(returning: false)
        } else if current == nil {
            // Not registered yet (or already finished, which looks the
            // same here and is harmless: this id will never be spoken
            // again). Remembered for its own matching speak() call only.
            pendingStopIds.insert(utteranceId)
        }
        // A stop naming a different id than whatever is currently playing
        // has no effect, and in particular is not remembered — only "not
        // yet registered" latches, not "registered as something else".
    }

    func releaseHeldStop() {
        holdStops = false
        heldStop?.resume()
        heldStop = nil
    }
}

private func makeCoordinator(
    recogniser: FakeRecogniser,
    synthesiser: FakeSynthesiser,
    collector: EventCollector
) -> LiveAudioCoordinator {
    LiveAudioCoordinator(
        sessionId: "session-1",
        captureOriginUptimeNanoseconds: 1_000_000_000,
        recogniser: recogniser,
        synthesiser: synthesiser,
        eventSink: collector.sink
    )
}

/// Polls `condition` until it is true or `timeout` elapses, so tests can
/// synchronise with a background `Task` deterministically instead of
/// sleeping a fixed, arbitrary amount.
private func waitUntil(
    timeout: TimeInterval = 2,
    _ condition: @Sendable () async -> Bool
) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() { return true }
        try? await Task.sleep(nanoseconds: 2_000_000)
    }
    return await condition()
}

// MARK: - Original coverage

@Test func startReportsModelPreparationThenListening() async throws {
    let collector = EventCollector()
    let coordinator = makeCoordinator(
        recogniser: FakeRecogniser(),
        synthesiser: FakeSynthesiser(),
        collector: collector
    )

    try await coordinator.start()

    let states = await collector.events.compactMap(\.state)
    #expect(states == [.preparingModel, .listening])
}

@Test func startFailureReportsFailedStateAndRethrows() async {
    let collector = EventCollector()
    let coordinator = makeCoordinator(
        recogniser: FakeRecogniser(startError: SidecarOperationError.permissionDenied(.microphone)),
        synthesiser: FakeSynthesiser(),
        collector: collector
    )

    await #expect(throws: SidecarOperationError.self) {
        try await coordinator.start()
    }
    let states = await collector.events.compactMap(\.state)
    #expect(states.last == .failed)
}

@Test func transcriptTimesAreRelativeToTheCaptureOrigin() async throws {
    let collector = EventCollector()
    let recogniser = FakeRecogniser()
    let coordinator = makeCoordinator(
        recogniser: recogniser,
        synthesiser: FakeSynthesiser(),
        collector: collector
    )
    try await coordinator.start()

    await recogniser.emit(.init(
        segmentId: "segment-1",
        text: "Any difference is flagged",
        isFinal: true,
        startNanoseconds: 3_500_000_000,
        endNanoseconds: 5_000_000_000
    ))

    let transcript = try #require(await collector.events.first { $0.event == .transcript })
    #expect(transcript.startMs == 2_500)
    #expect(transcript.endMs == 4_000)
    #expect(transcript.isFinal == true)
    #expect(transcript.text == "Any difference is flagged")
}

@Test func segmentsBeforeTheCaptureOriginClampToZero() async throws {
    let collector = EventCollector()
    let recogniser = FakeRecogniser()
    let coordinator = makeCoordinator(
        recogniser: recogniser,
        synthesiser: FakeSynthesiser(),
        collector: collector
    )
    try await coordinator.start()

    await recogniser.emit(.init(
        segmentId: "segment-early",
        text: "early",
        isFinal: false,
        startNanoseconds: 500_000_000,
        endNanoseconds: 900_000_000
    ))

    let transcript = try #require(await collector.events.first { $0.event == .transcript })
    #expect(transcript.startMs == 0)
    #expect(transcript.endMs == 0)
}

@Test func pausingSuppressesTranscriptsAndResumingRestoresThem() async throws {
    let collector = EventCollector()
    let recogniser = FakeRecogniser()
    let coordinator = makeCoordinator(
        recogniser: recogniser,
        synthesiser: FakeSynthesiser(),
        collector: collector
    )
    try await coordinator.start()

    await coordinator.setPaused(true)
    await recogniser.emit(.init(
        segmentId: "segment-while-paused",
        text: "ignored",
        isFinal: true,
        startNanoseconds: 2_000_000_000,
        endNanoseconds: 2_100_000_000
    ))
    await coordinator.setPaused(false)
    await recogniser.emit(.init(
        segmentId: "segment-after",
        text: "heard",
        isFinal: true,
        startNanoseconds: 3_000_000_000,
        endNanoseconds: 3_100_000_000
    ))

    let texts = await collector.events.filter { $0.event == .transcript }.compactMap(\.text)
    #expect(texts == ["heard"])
    let states = await collector.events.compactMap(\.state)
    #expect(states == [.preparingModel, .listening, .paused, .listening])
}

@Test func utterancesPlayInOrderAndReportStartedThenFinished() async throws {
    let collector = EventCollector()
    let synthesiser = FakeSynthesiser()
    let coordinator = makeCoordinator(
        recogniser: FakeRecogniser(),
        synthesiser: synthesiser,
        collector: collector
    )
    try await coordinator.start()

    await coordinator.speak(utteranceId: "utterance-1", text: "First sentence.")
    await coordinator.speak(utteranceId: "utterance-2", text: "Second sentence.")
    await coordinator.drainForTesting()

    #expect(await synthesiser.spoken == ["First sentence.", "Second sentence."])
    let phases = await collector.events
        .filter { $0.event == .speech }
        .map { "\($0.utteranceId ?? "")/\($0.phase?.rawValue ?? "")" }
    #expect(phases == [
        "utterance-1/started",
        "utterance-1/finished",
        "utterance-2/started",
        "utterance-2/finished",
    ])
}

@Test func stopSpeakingCancelsEveryQueuedUtterance() async throws {
    let collector = EventCollector()
    let coordinator = makeCoordinator(
        recogniser: FakeRecogniser(),
        synthesiser: FakeSynthesiser(),
        collector: collector
    )
    try await coordinator.start()

    await coordinator.speak(utteranceId: "utterance-1", text: "One.")
    await coordinator.speak(utteranceId: "utterance-2", text: "Two.")
    await coordinator.stopSpeaking()
    await coordinator.drainForTesting()

    let cancelled = await collector.events
        .filter { $0.phase == .cancelled }
        .compactMap(\.utteranceId)
    #expect(cancelled.contains("utterance-2"))
}

// MARK: - P1: a stop/pause that lands while `started` is still being sent
// must never let the utterance reach the synthesiser.

@Test func stopSpeakingDuringStartedEmitCancelsRatherThanLettingItPlay() async throws {
    let collector = EventCollector()
    let synthesiser = FakeSynthesiser()
    let coordinator = makeCoordinator(recogniser: FakeRecogniser(), synthesiser: synthesiser, collector: collector)
    try await coordinator.start()

    await collector.setGate { $0.event == .speech && $0.phase == .started && $0.utteranceId == "A" }
    await coordinator.speak(utteranceId: "A", text: "Alpha")
    #expect(await waitUntil { await collector.heldCount == 1 })

    // Nothing has reached the synthesiser yet (the drain loop is still
    // suspended sending `started`), so this returns without touching it —
    // fully, before the gate below is released.
    await coordinator.stopSpeaking()

    await collector.release()
    #expect(await waitUntil {
        await collector.events.contains { $0.utteranceId == "A" && $0.phase == .cancelled }
    })

    #expect(await synthesiser.spoken.isEmpty, "A must never reach the synthesiser: stopSpeaking landed before it was sent")
    let phases = await collector.events.filter { $0.utteranceId == "A" }.compactMap(\.phase)
    #expect(phases == [.started, .cancelled])
}

@Test func pausingDuringStartedEmitCancelsRatherThanLettingItPlay() async throws {
    let collector = EventCollector()
    let synthesiser = FakeSynthesiser()
    let coordinator = makeCoordinator(recogniser: FakeRecogniser(), synthesiser: synthesiser, collector: collector)
    try await coordinator.start()

    await collector.setGate { $0.event == .speech && $0.phase == .started && $0.utteranceId == "A" }
    await coordinator.speak(utteranceId: "A", text: "Alpha")
    #expect(await waitUntil { await collector.heldCount == 1 })

    await coordinator.setPaused(true)

    await collector.release()
    #expect(await waitUntil {
        await collector.events.contains { $0.utteranceId == "A" && $0.phase == .cancelled }
    })

    #expect(await synthesiser.spoken.isEmpty, "A must never reach the synthesiser: the pause landed before it was sent")
    let phases = await collector.events.filter { $0.utteranceId == "A" }.compactMap(\.phase)
    #expect(phases == [.started, .cancelled])
    let states = await collector.events.compactMap(\.state)
    #expect(states.last == .paused)
}

@Test func stoppingDuringStartedEmitCancelsRatherThanLettingItPlay() async throws {
    let collector = EventCollector()
    let synthesiser = FakeSynthesiser()
    let recogniser = FakeRecogniser()
    let coordinator = makeCoordinator(recogniser: recogniser, synthesiser: synthesiser, collector: collector)
    try await coordinator.start()

    await collector.setGate { $0.event == .speech && $0.phase == .started && $0.utteranceId == "A" }
    await coordinator.speak(utteranceId: "A", text: "Alpha")
    #expect(await waitUntil { await collector.heldCount == 1 })

    // stop() blocks on the drain quiescing, which cannot happen until the
    // gate below is released, so it has to run in the background. Once
    // recogniser.stop() has been called, stopSpeaking() (and so the
    // generation bump) has already returned.
    let stopTask = Task { await coordinator.stop() }
    #expect(await waitUntil { await recogniser.stopCallCount == 1 })

    await collector.release()
    await stopTask.value

    #expect(await synthesiser.spoken.isEmpty, "A must never reach the synthesiser: stop landed before it was sent")
    let phases = await collector.events.filter { $0.utteranceId == "A" }.compactMap(\.phase)
    #expect(phases == [.started, .cancelled])
}

// MARK: - P2: a state event superseded while its call was suspended must
// not be sent stale.

@Test func unpausingWhilePauseIsStillStoppingSpeechSuppressesTheStalePausedEvent() async throws {
    let collector = EventCollector()
    let synthesiser = FakeSynthesiser()
    let coordinator = makeCoordinator(recogniser: FakeRecogniser(), synthesiser: synthesiser, collector: collector)
    try await coordinator.start()
    await synthesiser.setAutoCompletes(false)

    await coordinator.speak(utteranceId: "A", text: "Alpha")
    #expect(await waitUntil { await synthesiser.isSpeaking })

    await synthesiser.setHoldStops(true)
    let pauseTask = Task { await coordinator.setPaused(true) }
    #expect(await waitUntil { await synthesiser.stopCallCount == 1 })

    // Runs to completion while setPaused(true) is still stuck waiting for
    // the synthesiser to acknowledge A's stop.
    await coordinator.setPaused(false)
    await coordinator.speak(utteranceId: "D", text: "Delta")

    await synthesiser.releaseHeldStop()
    await pauseTask.value
    #expect(await waitUntil { await synthesiser.spoken.contains("Delta") })
    await synthesiser.finishCurrent()
    await coordinator.drainForTesting()

    let states = await collector.events.compactMap(\.state)
    #expect(!states.contains(.paused), "setPaused(true)'s stop resolved only after it was superseded by setPaused(false); its .paused report must be dropped")
    #expect(states.last == .listening)
    let aPhases = await collector.events.filter { $0.utteranceId == "A" }.compactMap(\.phase)
    #expect(aPhases == [.started, .cancelled])
    let dPhases = await collector.events.filter { $0.utteranceId == "D" }.compactMap(\.phase)
    #expect(dPhases == [.started, .finished], "the coordinator must still be genuinely usable, not stuck reporting paused")
}

// MARK: - P3: a stop's synthesiser call must never land on a later,
// unrelated utterance.

@Test func stopSpeakingNeverCancelsALaterUtteranceThatStartedAfterTheStopWasRequested() async throws {
    let collector = EventCollector()
    let synthesiser = FakeSynthesiser()
    let coordinator = makeCoordinator(recogniser: FakeRecogniser(), synthesiser: synthesiser, collector: collector)
    try await coordinator.start()
    await synthesiser.setAutoCompletes(false)

    await coordinator.speak(utteranceId: "A", text: "Alpha")
    await coordinator.speak(utteranceId: "B", text: "Bravo")
    #expect(await waitUntil { await synthesiser.isSpeaking })

    // Held on the event sink, not the synthesiser: the sink is a socket to
    // the Electron process and can genuinely be slow; a local
    // stopSpeaking() call is not a realistic thing to be slow, and holding
    // it directly would just re-delay whichever step the coordinator
    // happens to run first, rather than testing what a slow sink can do.
    // This is exactly where the original bug's delay came from: the fixed
    // coordinator calls the synthesiser before this loop, so by the time
    // this gate is even reached, it has already decided (and, correctly,
    // already acted) whether A needed stopping; the unfixed coordinator
    // calls the synthesiser after this loop, so its synthesiser call is
    // still waiting on whatever this gate is holding.
    await collector.setGate { $0.event == .speech && $0.phase == .cancelled && $0.utteranceId == "B" }
    let stopTask = Task { await coordinator.stopSpeaking() }
    #expect(await waitUntil { await collector.heldCount == 1 })

    // A reaches a terminal event on its own -- via finishCurrent() for the
    // unfixed coordinator (nothing else can resolve it while its
    // synthesiser call is still queued behind this loop), or already
    // having been correctly, immediately cancelled by the fixed
    // coordinator's own targeted stop (in which case this is a no-op). The
    // drain loop then fully quiesces before a new utterance is queued.
    await synthesiser.finishCurrent()
    #expect(await waitUntil {
        await collector.events.contains { $0.utteranceId == "A" && ($0.phase == .finished || $0.phase == .cancelled) }
    })
    await coordinator.drainForTesting()
    await coordinator.speak(utteranceId: "C", text: "Charlie")
    #expect(await waitUntil { await synthesiser.isSpeaking })
    #expect(await waitUntil { await synthesiser.spoken.contains("Charlie") })

    // Only now does the stop requested long before C existed finish
    // sending its (already-decided, already-delivered) effects.
    await collector.release()
    await stopTask.value

    #expect(await synthesiser.isSpeaking, "C must still be playing, untouched by a stop requested before C existed")
    await synthesiser.finishCurrent()
    await coordinator.drainForTesting()

    let aPhases = await collector.events.filter { $0.utteranceId == "A" }.compactMap(\.phase)
    #expect(aPhases.count == 2 && aPhases.first == .started, "A must still get exactly one terminal event")
    let bPhases = await collector.events.filter { $0.utteranceId == "B" }.compactMap(\.phase)
    #expect(bPhases == [.cancelled])
    let cPhases = await collector.events.filter { $0.utteranceId == "C" }.compactMap(\.phase)
    #expect(cPhases == [.started, .finished], "C must finish normally: the stale stop meant for A must not cancel it")
}

// MARK: - Invariant 3 also covers an utterance still queued, not yet
// dequeued, when the pause lands.

@Test func pausingCancelsAnUtteranceNotYetDequeued() async throws {
    let collector = EventCollector()
    let synthesiser = FakeSynthesiser()
    let coordinator = makeCoordinator(recogniser: FakeRecogniser(), synthesiser: synthesiser, collector: collector)
    try await coordinator.start()
    await synthesiser.setAutoCompletes(false)

    // A is dequeued and genuinely playing; B is still sitting in `queue`
    // -- the drain loop cannot even look at it again until A resolves, so
    // it is guaranteed still queued, not dequeued, at the point below.
    await coordinator.speak(utteranceId: "A", text: "Alpha")
    await coordinator.speak(utteranceId: "B", text: "Bravo")
    #expect(await waitUntil { await synthesiser.isSpeaking })

    await coordinator.setPaused(true)

    let bPhases = await collector.events.filter { $0.utteranceId == "B" }.compactMap(\.phase)
    #expect(bPhases == [.cancelled], "B must be cancelled even though the drain loop never dequeued it")

    await synthesiser.finishCurrent()
    await coordinator.drainForTesting()
}

// MARK: - P5: a state event must reflect what is still true, even when
// start() is still in flight.

@Test func pausingDuringStartDoesNotClaimListeningOnceItCompletes() async throws {
    let collector = EventCollector()
    let recogniser = FakeRecogniser(holdsStart: true)
    let coordinator = makeCoordinator(recogniser: recogniser, synthesiser: FakeSynthesiser(), collector: collector)

    let startTask = Task { try await coordinator.start() }
    #expect(await waitUntil { await recogniser.isHoldingStart })
    await coordinator.setPaused(true)
    await recogniser.releaseStart()
    try await startTask.value

    let states = await collector.events.compactMap(\.state)
    #expect(states == [.preparingModel, .paused], "start() must not append .listening once a concurrent pause landed first")
}

@Test func stoppingDuringStartNeverClaimsListening() async throws {
    let collector = EventCollector()
    let recogniser = FakeRecogniser(holdsStart: true)
    let coordinator = makeCoordinator(recogniser: recogniser, synthesiser: FakeSynthesiser(), collector: collector)

    let startTask = Task { try await coordinator.start() }
    #expect(await waitUntil { await recogniser.isHoldingStart })
    // stop() calls recogniser.stop() before recogniser.start() has even
    // returned — exercised explicitly, since a real recogniser could still
    // be mid-start at that point.
    let stopTask = Task { await coordinator.stop() }
    #expect(await waitUntil { await recogniser.stopCallCount == 1 })
    await recogniser.releaseStart()
    try await startTask.value
    await stopTask.value

    let states = await collector.events.compactMap(\.state)
    #expect(states == [.preparingModel], "start() must not claim listening once stop() landed first")

    await coordinator.speak(utteranceId: "ignored", text: "no")
    let phases = await collector.events.filter { $0.utteranceId == "ignored" }.compactMap(\.phase)
    #expect(phases == [.cancelled])
}

// MARK: - stop() waits for the drain to quiesce.

/// Records whether a background `Task` has completed yet. Used instead of
/// racing a `Task` against a timer: paired with a held collector event, it
/// turns "did stop() return too early" from something to catch in time into
/// something that is structurally impossible while the hold is in place.
private actor CompletionFlag {
    private(set) var isSet = false
    func set() { isSet = true }
}

@Test func stopDoesNotReturnUntilTheInFlightUtteranceHasItsTerminalEvent() async throws {
    let collector = EventCollector()
    let synthesiser = FakeSynthesiser()
    let coordinator = makeCoordinator(recogniser: FakeRecogniser(), synthesiser: synthesiser, collector: collector)
    try await coordinator.start()
    await synthesiser.setAutoCompletes(false)

    await coordinator.speak(utteranceId: "A", text: "Alpha")
    #expect(await waitUntil { await synthesiser.isSpeaking })

    // Hold A's terminal event: stop() cannot return until the drain loop
    // has actually sent it (that send is on the same task stop() awaits),
    // so holding it makes "stop() has not returned yet" a certainty to
    // check rather than a race to win against real time. The previous
    // version of this test raced stop() against nothing and, against an
    // unfixed coordinator, happened to observe the (wrong) already-returned
    // state only 989/1000 times.
    await collector.setGate { $0.utteranceId == "A" && ($0.phase == .finished || $0.phase == .cancelled) }
    let stopReturned = CompletionFlag()
    let stopTask = Task {
        await coordinator.stop()
        await stopReturned.set()
    }
    #expect(await waitUntil { await collector.heldCount == 1 })

    try? await Task.sleep(nanoseconds: 50_000_000)
    #expect(await stopReturned.isSet == false, "stop() must not return before A's terminal event has actually been sent")

    await collector.release()
    await stopTask.value

    #expect(await stopReturned.isSet)
    let phases = await collector.events.filter { $0.utteranceId == "A" }.compactMap(\.phase)
    #expect(phases == [.started, .cancelled])
}

// MARK: - Important 2 remainder: stop() during start() must leave the
// recogniser genuinely stopped, not just tell it to stop while it was
// still starting up.

@Test func stoppingDuringStartLeavesTheRecogniserNotRunning() async throws {
    let collector = EventCollector()
    let recogniser = FakeRecogniser(holdsStart: true)
    let coordinator = makeCoordinator(recogniser: recogniser, synthesiser: FakeSynthesiser(), collector: collector)

    let startTask = Task { try await coordinator.start() }
    #expect(await waitUntil { await recogniser.isHoldingStart })

    let stopTask = Task { await coordinator.stop() }
    #expect(await waitUntil { await recogniser.stopCallCount == 1 })
    await stopTask.value
    // stop()'s first call to recogniser.stop() happened while start() was
    // still suspended -- confirm that ordering, since it is the premise of
    // the bug: a real recogniser has nothing running yet to stop at this
    // point.
    #expect(await recogniser.isHoldingStart, "stop() must not itself have unblocked start()")

    await recogniser.releaseStart()
    try await startTask.value

    #expect(await recogniser.stopCallCount == 2, "recogniser.stop() must be called again once it has actually finished starting")
    #expect(await recogniser.running == false, "the recogniser must not be left running once both calls have returned")
}

// MARK: - New Important: an untargeted stop cannot be correct in both
// directions -- holding it for the next speak() cancels a later, unrelated
// utterance; dropping it loses a stop that arrives just before speak()
// registers. The synthesiser's stop now names its utterance.

/// Direct contract tests of `FakeSynthesiser` itself, not the coordinator:
/// these two behaviours are about what a `SpeechSynthesizing` conformance
/// must do, and the coordinator has no public way to construct "a stop for
/// an id other than whatever is in flight" -- it only ever targets its one
/// in-flight utterance.
@Test func aStopIssuedBeforeSpeakRegistersPreventsItFromPlaying() async {
    let synthesiser = FakeSynthesiser()
    await synthesiser.setAutoCompletes(false)

    await synthesiser.stopSpeaking(utteranceId: "A")
    let completed = await synthesiser.speak("Alpha", utteranceId: "A")

    #expect(completed == false, "a stop remembered for an id must apply to that same id's speak() call")
    #expect(await synthesiser.isSpeaking == false, "a remembered stop must return immediately, without ever actually playing")
}

@Test func aStopForADifferentIdHasNoEffectOnTheUtterancePlaying() async {
    let synthesiser = FakeSynthesiser()
    await synthesiser.setAutoCompletes(false)

    let speakTask = Task { await synthesiser.speak("Alpha", utteranceId: "A") }
    #expect(await waitUntil { await synthesiser.isSpeaking })

    await synthesiser.stopSpeaking(utteranceId: "Z")

    #expect(await synthesiser.isSpeaking, "A must still be playing: the stop named a different, unrelated id")
    await synthesiser.finishCurrent()
    #expect(await speakTask.value, "A must still finish normally")
}

/// Probe F: a stop decided while A is in flight, but which only reaches
/// the synthesiser after A has already finished on its own — resuming
/// from `synthesiser.speak(_:utteranceId:)` is itself a scheduling event,
/// not guaranteed to run before some other already-ready job on this
/// actor — must never affect a later, unrelated utterance queued after it.
/// `async let` races `stopSpeaking()` against `finishCurrent()` without
/// pinning which wins; run enough times and both orderings occur. Neither
/// may ever let C be cancelled: unlike round 2's global "remembered stop"
/// requirement (see this file's `FakeSynthesiser` and the report), the
/// targeted contract makes the outcome correct regardless of which one
/// wins, so this does not need to hit one specific interleaving to prove
/// anything — it needs to show that *no* interleaving, across many tries,
/// ever produces the wrong answer.
@Test func aStopDecidedJustAfterAnUtteranceFinishesNaturallyNeverCancelsALaterOne() async throws {
    for _ in 0..<300 {
        let collector = EventCollector()
        let synthesiser = FakeSynthesiser()
        let coordinator = makeCoordinator(recogniser: FakeRecogniser(), synthesiser: synthesiser, collector: collector)
        try await coordinator.start()
        await synthesiser.setAutoCompletes(false)

        await coordinator.speak(utteranceId: "A", text: "Alpha")
        #expect(await waitUntil { await synthesiser.isSpeaking })

        async let stopper: Void = coordinator.stopSpeaking()
        await synthesiser.finishCurrent()
        await stopper

        await coordinator.drainForTesting()
        await coordinator.speak(utteranceId: "C", text: "Charlie")
        #expect(await waitUntil { await synthesiser.spoken.contains("Charlie") })
        await synthesiser.finishCurrent()
        await coordinator.drainForTesting()

        let cPhases = await collector.events.filter { $0.utteranceId == "C" }.compactMap(\.phase)
        #expect(cPhases == [.started, .finished], "C must never be cancelled by a stop that targeted an already-finished A: \(cPhases)")
    }
}

// MARK: - New Important: a failed start() must not strand queued speech or
// spin the drain forever trying to redeliver it.

@Test func failedStartCancelsQueuedSpeechAndStopsTheDrainFromSpinning() async throws {
    let collector = EventCollector()
    let synthesiser = FakeSynthesiser()
    let recogniser = FakeRecogniser(startError: SidecarOperationError.captureFailed, holdsStart: true)
    let coordinator = makeCoordinator(recogniser: recogniser, synthesiser: synthesiser, collector: collector)
    await synthesiser.setAutoCompletes(false)

    let startTask = Task { try? await coordinator.start() }
    #expect(await waitUntil { await recogniser.isHoldingStart })

    // speak() has no dependency on start() having already succeeded.
    await coordinator.speak(utteranceId: "A", text: "Alpha")
    await coordinator.speak(utteranceId: "B", text: "Bravo")
    #expect(await waitUntil { await synthesiser.isSpeaking })

    await recogniser.releaseStart()
    await startTask.value

    // start() awaits the drain before it throws (fold-in a): by the time
    // it has returned, both utterances' terminal events must already be
    // recorded -- no extra waiting or draining needed -- and A must have
    // been genuinely stopped by the failure path's own targeted stop
    // (nothing here resolves it any other way).
    let events = await collector.events
    let aPhases = events.filter { $0.utteranceId == "A" }.compactMap(\.phase)
    #expect(aPhases == [.started, .cancelled])
    let bPhases = events.filter { $0.utteranceId == "B" }.compactMap(\.phase)
    #expect(bPhases == [.cancelled])

    // Fold-in (a), checked directly rather than just inferred from "no
    // more waiting was needed" above: both terminal events precede
    // `failed`, not just eventually arrive.
    let failedIndex = try #require(events.firstIndex { $0.state == .failed })
    let aTerminalIndex = try #require(events.firstIndex { $0.utteranceId == "A" && $0.phase == .cancelled })
    let bTerminalIndex = try #require(events.firstIndex { $0.utteranceId == "B" && $0.phase == .cancelled })
    #expect(aTerminalIndex < failedIndex)
    #expect(bTerminalIndex < failedIndex)

    // Deterministic replacement for a CPU-usage check (fold-in c): the
    // drain must have genuinely stopped, not merely be caught between two
    // iterations of a restart loop that a snapshot-based check taken at
    // the wrong instant could not tell apart from "stopped cleanly".
    #expect(await coordinator.isDrainingForTesting == false, "no drain task may remain once the failure path has returned")
}

// MARK: - Folded in: no state event may follow stop().

@Test func noStateEventFollowsStop() async throws {
    let collector = EventCollector()
    let synthesiser = FakeSynthesiser()
    let recogniser = FakeRecogniser()
    let coordinator = makeCoordinator(recogniser: recogniser, synthesiser: synthesiser, collector: collector)
    try await coordinator.start()
    await synthesiser.setAutoCompletes(false)

    await coordinator.speak(utteranceId: "A", text: "Alpha")
    #expect(await waitUntil { await synthesiser.isSpeaking })

    await synthesiser.setHoldStops(true)
    let pauseTask = Task { await coordinator.setPaused(true) }
    #expect(await waitUntil { await synthesiser.stopCallCount == 1 })

    // stop() runs to completion while setPaused(true) is still stuck
    // waiting for the synthesiser to acknowledge A's stop (that stop is
    // now one-shot held, so stop()'s own, unheld stopSpeaking() call is
    // free to resolve A itself and let stop() finish).
    await coordinator.stop()
    let eventCountWhenStopReturned = await collector.events.count

    // Neither of these may add anything: not the still-suspended pause
    // call, once it resumes, and not this direct call either.
    await coordinator.setPaused(false)
    await synthesiser.releaseHeldStop()
    await pauseTask.value

    let states = await collector.events.compactMap(\.state)
    #expect(states == [.preparingModel, .listening], "no state event may follow stop(), from the still-suspended pause or the later unpause")
    #expect(await collector.events.count == eventCountWhenStopReturned, "nothing may be sent once stop() has returned")
}

// MARK: - Open item 4: state:failed must not follow stop().

@Test func failedIsNotSentWhenStopRanDuringAFailingStart() async throws {
    let collector = EventCollector()
    let recogniser = FakeRecogniser(startError: SidecarOperationError.captureFailed, holdsStart: true)
    let coordinator = makeCoordinator(recogniser: recogniser, synthesiser: FakeSynthesiser(), collector: collector)

    let startTask = Task { try? await coordinator.start() }
    #expect(await waitUntil { await recogniser.isHoldingStart })

    // stop() runs to completion -- and so sets stopCalled -- while
    // start() is still suspended inside recogniser.start().
    await coordinator.stop()

    // Only now does the held start() attempt actually resolve, and (since
    // this recogniser is configured to fail) throw.
    await recogniser.releaseStart()
    _ = await startTask.value

    let states = await collector.events.compactMap(\.state)
    #expect(!states.contains(.failed), "stop() already ran; the failing start() must not send a stale failed after it")
}

// MARK: - Open item 3, point 6: a failed start() leaves the recogniser
// stopped, not just the coordinator.

@Test func aFailedStartLeavesTheRecogniserStopped() async {
    let collector = EventCollector()
    let recogniser = FakeRecogniser(startError: SidecarOperationError.captureFailed)
    let coordinator = makeCoordinator(recogniser: recogniser, synthesiser: FakeSynthesiser(), collector: collector)

    await #expect(throws: SidecarOperationError.self) { try await coordinator.start() }

    #expect(await recogniser.stopCallCount >= 1, "the failure path must call recogniser.stop(), not just set an internal flag")
    #expect(await recogniser.running == false)
}

// MARK: - Folded-in coverage: refusal paths and the failure reason string.

@Test func speakWhilePausedIsRefusedWithoutReachingTheSynthesiser() async throws {
    let collector = EventCollector()
    let synthesiser = FakeSynthesiser()
    let coordinator = makeCoordinator(recogniser: FakeRecogniser(), synthesiser: synthesiser, collector: collector)
    try await coordinator.start()
    await coordinator.setPaused(true)

    await coordinator.speak(utteranceId: "ignored", text: "should not play")

    let phases = await collector.events.filter { $0.utteranceId == "ignored" }.compactMap(\.phase)
    #expect(phases == [.cancelled])
    #expect(await synthesiser.spoken.isEmpty)
}

@Test func speakAfterStopIsRefusedWithoutReachingTheSynthesiser() async throws {
    let collector = EventCollector()
    let synthesiser = FakeSynthesiser()
    let coordinator = makeCoordinator(recogniser: FakeRecogniser(), synthesiser: synthesiser, collector: collector)
    try await coordinator.start()
    await coordinator.stop()

    await coordinator.speak(utteranceId: "ignored", text: "should not play")

    let phases = await collector.events.filter { $0.utteranceId == "ignored" }.compactMap(\.phase)
    #expect(phases == [.cancelled])
    #expect(await synthesiser.spoken.isEmpty)
}

@Test func speakAfterAFailedStartIsRefused() async {
    let collector = EventCollector()
    let synthesiser = FakeSynthesiser()
    let coordinator = makeCoordinator(
        recogniser: FakeRecogniser(startError: SidecarOperationError.permissionDenied(.microphone)),
        synthesiser: synthesiser,
        collector: collector
    )
    await #expect(throws: SidecarOperationError.self) { try await coordinator.start() }

    await coordinator.speak(utteranceId: "ignored", text: "should not play")

    let phases = await collector.events.filter { $0.utteranceId == "ignored" }.compactMap(\.phase)
    #expect(phases == [.cancelled])
    #expect(await synthesiser.spoken.isEmpty)
}

@Test func startFailureReasonReflectsTheUnderlyingOperationError() async {
    let collector = EventCollector()
    let coordinator = makeCoordinator(
        recogniser: FakeRecogniser(startError: SidecarOperationError.captureFailed),
        synthesiser: FakeSynthesiser(),
        collector: collector
    )

    await #expect(throws: SidecarOperationError.self) { try await coordinator.start() }

    let reasons = await collector.events.compactMap(\.reason)
    #expect(reasons == ["capture_failed"])
}

@Test func unmappedOperationErrorsReportTheGenericReason() async {
    let collector = EventCollector()
    let coordinator = makeCoordinator(
        recogniser: FakeRecogniser(startError: SidecarOperationError.unsupported("live_audio")),
        synthesiser: FakeSynthesiser(),
        collector: collector
    )

    await #expect(throws: SidecarOperationError.self) { try await coordinator.start() }

    let reasons = await collector.events.compactMap(\.reason)
    #expect(reasons == ["live_audio_failed"])
}
