import Foundation
import Testing
@testable import ReplayCaptureCore

private actor EventCollector {
    private(set) var events: [SidecarLiveEventEnvelope] = []

    func record(_ event: SidecarLiveEventEnvelope) {
        events.append(event)
    }

    nonisolated var sink: @Sendable (SidecarLiveEventEnvelope) async -> Void {
        { event in await self.record(event) }
    }
}

private final class FakeRecogniser: SpeechRecognizing, @unchecked Sendable {
    private var handler: (@Sendable (RecognisedSegment) async -> Void)?
    private let startError: Error?
    private(set) var stopped = false

    init(startError: Error? = nil) {
        self.startError = startError
    }

    func start(handler: @escaping @Sendable (RecognisedSegment) async -> Void) async throws {
        if let startError { throw startError }
        self.handler = handler
    }

    func stop() async {
        stopped = true
    }

    func emit(_ segment: RecognisedSegment) async {
        await handler?(segment)
    }
}

private actor FakeSynthesiser: SpeechSynthesizing {
    private(set) var spoken: [String] = []
    private var stopRequested = false

    func speak(_ text: String) async -> Bool {
        spoken.append(text)
        return !stopRequested
    }

    func stopSpeaking() async {
        stopRequested = true
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
