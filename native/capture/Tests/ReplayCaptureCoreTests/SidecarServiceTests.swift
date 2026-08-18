import Foundation
import Testing
@testable import ReplayCaptureCore

@Test func heartbeatEchoesNonceAndReportsUptime() async {
    let service = SidecarService(
        recorder: FakeRecorder(),
        inputMonitor: FakeInputMonitor(),
        permissions: FakePermissions(),
        actions: FakeActions(),
        monotonicNow: { 2_000_000_000 }
    )
    let command = SidecarCommandEnvelope(
        requestId: "request-1",
        command: .heartbeat(.init(nonce: "nonce-1"))
    )

    let response = await service.handle(command)

    #expect(response.ok)
    #expect(response.result?.type == .heartbeat)
    #expect(response.result?.nonce == "nonce-1")
    #expect(response.result?.uptimeMs != nil)
    #expect(response.result?.captureHealthy == true)
}

@Test func recordRefusesMissingRequiredPermission() async throws {
    let permissions = FakePermissions(states: [
        .screenRecording: .granted,
        .accessibility: .denied,
        .inputMonitoring: .granted,
        .microphone: .notDetermined
    ])
    let service = SidecarService(
        recorder: FakeRecorder(),
        inputMonitor: FakeInputMonitor(),
        permissions: permissions,
        actions: FakeActions()
    )
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("ReplayCaptureTests-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }

    let response = await service.handle(.init(
        requestId: "request-1",
        command: .record(.init(
            sessionId: "session-1",
            sessionDirectory: directory.path,
            includeAudio: false,
            display: .init(width: 100, height: 50, scale: 1)
        ))
    ))

    #expect(!response.ok)
    #expect(response.error?.code == .permissionDenied)
}

@Test func recordPreservesAPermissionFailureFromMonitorStartup() async throws {
    let monitor = FakeInputMonitor(startError: .permissionDenied(.inputMonitoring))
    let service = SidecarService(
        recorder: FakeRecorder(),
        inputMonitor: monitor,
        permissions: FakePermissions(),
        actions: FakeActions()
    )
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("ReplayCaptureTests-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }

    let response = await service.handle(.init(
        requestId: "permission-race",
        command: .record(.init(
            sessionId: "session-permission-race",
            sessionDirectory: directory.path,
            includeAudio: false,
            display: .init(width: 100, height: 50, scale: 1)
        ))
    ))

    #expect(response.error?.code == .permissionDenied)
    let metadata = try JSONDecoder.replay.decode(
        SessionMetadata.self,
        from: Data(contentsOf: directory.appendingPathComponent("meta.json"))
    )
    #expect(metadata.status == .interrupted)
    #expect(metadata.partial)
}

@Test func recordReportsAnUnwritableSessionPathAsIOFailure() async throws {
    let parent = FileManager.default.temporaryDirectory
        .appendingPathComponent("ReplayCaptureTests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: parent) }
    let fileInsteadOfDirectory = parent.appendingPathComponent("not-a-directory")
    try Data("occupied".utf8).write(to: fileInsteadOfDirectory)
    let service = SidecarService(
        recorder: FakeRecorder(),
        inputMonitor: FakeInputMonitor(),
        permissions: FakePermissions(),
        actions: FakeActions()
    )

    let response = await service.handle(.init(
        requestId: "unwritable-session",
        command: .record(.init(
            sessionId: "session-io-error",
            sessionDirectory: fileInsteadOfDirectory.path,
            includeAudio: false,
            display: .init(width: 100, height: 50, scale: 1)
        ))
    ))

    #expect(response.error?.code == .ioFailed)
}

@Test func recordRejectsARecorderThatProducesNoVideoFrames() async throws {
    let service = SidecarService(
        recorder: FakeRecorder(startError: .noVideoFrames),
        inputMonitor: FakeInputMonitor(),
        permissions: FakePermissions(),
        actions: FakeActions()
    )
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("ReplayCaptureTests-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }

    let response = await service.handle(.init(
        requestId: "no-video-frames",
        command: .record(.init(
            sessionId: "session-no-video-frames",
            sessionDirectory: directory.path,
            includeAudio: false,
            display: .init(width: 100, height: 50, scale: 1)
        ))
    ))

    #expect(response.error?.code == .captureFailed)
    #expect(response.error?.message.contains("did not provide any video frames") == true)
    let metadata = try JSONDecoder.replay.decode(
        SessionMetadata.self,
        from: Data(contentsOf: directory.appendingPathComponent("meta.json"))
    )
    #expect(metadata.status == .interrupted)
    #expect(metadata.partial)
    #expect(metadata.interruptionReason == "no_video_frames")
}

@Test func secureActTypeIsRefusedWithoutCallingTyper() async {
    let actions = FakeActions(focusedSecure: true)
    let service = SidecarService(
        recorder: FakeRecorder(),
        inputMonitor: FakeInputMonitor(),
        permissions: FakePermissions(),
        actions: actions
    )

    let response = await service.handle(.init(
        requestId: "request-1",
        command: .actType(.init(text: "must-not-be-typed"))
    ))

    #expect(!response.ok)
    #expect(response.error?.code == .secureFieldRequiresHumanInput)
    let typed = await actions.typedTexts()
    #expect(typed.isEmpty)
}

@Test func targetedActTypeLetsPerformerValidateTheNewFocus() async {
    let actions = FakeActions(focusedSecure: true)
    let service = SidecarService(
        recorder: FakeRecorder(),
        inputMonitor: FakeInputMonitor(),
        permissions: FakePermissions(),
        actions: actions
    )

    let response = await service.handle(.init(
        requestId: "targeted-type",
        command: .actType(.init(
            text: "safe text",
            target: .init(role: "AXTextArea", bundleId: "com.apple.TextEdit")
        ))
    ))

    #expect(response.ok)
    #expect(await actions.typedTexts() == ["safe text"])
}

@Test func inputEventIsPersistedDuringRecording() async throws {
    let monitor = FakeInputMonitor()
    let recorder = FakeRecorder()
    let service = SidecarService(
        recorder: recorder,
        inputMonitor: monitor,
        permissions: FakePermissions(),
        actions: FakeActions()
    )
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("ReplayCaptureTests-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }

    let start = await service.handle(.init(
        requestId: "start",
        command: .record(.init(
            sessionId: "session-1",
            sessionDirectory: directory.path,
            includeAudio: false,
            display: .init(width: 100, height: 50, scale: 1)
        ))
    ))
    #expect(start.ok)

    await monitor.emit(
        .click(
            id: "click-1",
            sessionId: "session-1",
            timestampMs: 10,
            position: .init(x: 3, y: 4),
            button: .left,
            clickCount: 1
        ),
        target: AccessibilityTarget(role: "AXButton", label: "Approve")
    )
    await service.flushPendingEventsForTesting()

    let contents = try String(
        contentsOf: directory.appendingPathComponent("events.jsonl"),
        encoding: .utf8
    )
    #expect(contents.contains("Approve"))
    let metadata = try JSONDecoder.replay.decode(
        SessionMetadata.self,
        from: Data(contentsOf: directory.appendingPathComponent("meta.json"))
    )
    #expect(metadata.appVersions["captureSidecar"] == ReplayCaptureBuildInfo.version)

    let stop = await service.handle(.init(
        requestId: "stop",
        command: .stop(.init(sessionId: "session-1"))
    ))
    #expect(stop.ok)
}

@Test func inputEventsUseTheVideoCaptureTimeOrigin() async throws {
    let expectedOrigin: UInt64 = 9_876_543_210
    let monitor = FakeInputMonitor()
    let service = SidecarService(
        recorder: FakeRecorder(captureOrigin: expectedOrigin),
        inputMonitor: monitor,
        permissions: FakePermissions(),
        actions: FakeActions()
    )
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("ReplayCaptureTests-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }

    let start = await service.handle(.init(
        requestId: "start-origin",
        command: .record(.init(
            sessionId: "session-origin",
            sessionDirectory: directory.path,
            includeAudio: false,
            display: .init(width: 100, height: 50, scale: 1)
        ))
    ))

    #expect(start.ok)
    #expect(monitor.receivedTimeOrigin() == expectedOrigin)
    _ = await service.handle(.init(
        requestId: "stop-origin",
        command: .stop(.init(sessionId: "session-origin"))
    ))
}

@Test func heartbeatAndStopExposeARecorderThatFailedAfterStartup() async throws {
    let recorder = FakeRecorder()
    let service = SidecarService(
        recorder: recorder,
        inputMonitor: FakeInputMonitor(),
        permissions: FakePermissions(),
        actions: FakeActions()
    )
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("ReplayCaptureTests-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }

    let start = await service.handle(.init(
        requestId: "start-unhealthy",
        command: .record(.init(
            sessionId: "session-unhealthy",
            sessionDirectory: directory.path,
            includeAudio: false,
            display: .init(width: 100, height: 50, scale: 1)
        ))
    ))
    #expect(start.ok)
    recorder.setHealthy(false)

    let heartbeat = await service.handle(.init(
        requestId: "heartbeat-unhealthy",
        command: .heartbeat(.init())
    ))
    #expect(heartbeat.result?.captureHealthy == false)

    let stop = await service.handle(.init(
        requestId: "stop-unhealthy",
        command: .stop(.init(sessionId: "session-unhealthy"))
    ))
    #expect(stop.error?.code == .captureFailed)

    let metadata = try JSONDecoder.replay.decode(
        SessionMetadata.self,
        from: Data(contentsOf: directory.appendingPathComponent("meta.json"))
    )
    #expect(metadata.status == .interrupted)
    #expect(metadata.partial)
}

@Test func stopPreservesTheNoVideoFramesFailureAndLeavesTheSessionPartial() async throws {
    let recorder = FakeRecorder(stopError: .noVideoFrames)
    let service = SidecarService(
        recorder: recorder,
        inputMonitor: FakeInputMonitor(),
        permissions: FakePermissions(),
        actions: FakeActions()
    )
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("ReplayCaptureTests-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }

    let start = await service.handle(.init(
        requestId: "start-no-video-stop",
        command: .record(.init(
            sessionId: "session-no-video-stop",
            sessionDirectory: directory.path,
            includeAudio: false,
            display: .init(width: 100, height: 50, scale: 1)
        ))
    ))
    #expect(start.ok)

    let stop = await service.handle(.init(
        requestId: "stop-no-video",
        command: .stop(.init(sessionId: "session-no-video-stop"))
    ))

    #expect(stop.error?.code == .captureFailed)
    #expect(stop.error?.message.contains("did not provide any video frames") == true)
    let metadata = try JSONDecoder.replay.decode(
        SessionMetadata.self,
        from: Data(contentsOf: directory.appendingPathComponent("meta.json"))
    )
    #expect(metadata.status == .interrupted)
    #expect(metadata.partial)
    #expect(metadata.interruptionReason == "no_video_frames")
}

@Test func safetyInterlockCanBeResetAfterAUserPause() throws {
    let interlock = SafetyInterlock()
    interlock.trip()

    #expect(throws: SidecarOperationError.safetyInterlockEngaged) {
        try interlock.check()
    }

    interlock.reset()
    #expect(throws: Never.self) {
        try interlock.check()
    }
}

@Test func extendedActCommandsReachTheActionAdapter() async {
    let actions = FakeActions()
    let service = SidecarService(
        recorder: FakeRecorder(),
        inputMonitor: FakeInputMonitor(),
        permissions: FakePermissions(),
        actions: actions
    )
    let commands: [SidecarCommand] = [
        .actKey(.init(keyCode: 36, modifiers: [.command])),
        .actScroll(.init(deltaX: 0, deltaY: 240)),
        .actDrag(.init(start: .init(x: 1, y: 2), end: .init(x: 3, y: 4))),
        .actNavigate(.init(url: "https://example.com/invoices"))
    ]

    for (index, command) in commands.enumerated() {
        let response = await service.handle(.init(requestId: "action-\(index)", command: command))
        #expect(response.ok)
    }

    let counts = await actions.actionCounts()
    #expect(counts.keys == 1)
    #expect(counts.scrolls == 1)
    #expect(counts.drags == 1)
    #expect(counts.navigations == 1)
}

@Test func secureFieldAlsoRefusesArbitraryKeyCommands() async {
    let service = SidecarService(
        recorder: FakeRecorder(),
        inputMonitor: FakeInputMonitor(),
        permissions: FakePermissions(),
        actions: FakeActions(focusedSecure: true)
    )

    let response = await service.handle(.init(
        requestId: "secure-key",
        command: .actKey(.init(keyCode: 0))
    ))

    #expect(response.error?.code == .secureFieldRequiresHumanInput)
}

@Test func guardrailSubscriptionForwardsUnsolicitedSafetyEvents() async {
    let safety = FakeSafetyMonitor()
    let received = SafetyEventCollector()
    let service = SidecarService(
        recorder: FakeRecorder(),
        inputMonitor: FakeInputMonitor(),
        permissions: FakePermissions(),
        actions: FakeActions(),
        safetyMonitor: safety,
        safetyEventSink: { event in await received.append(event) }
    )

    let response = await service.handle(.init(
        requestId: "subscribe",
        command: .guardrailsSubscribe(.init())
    ))
    #expect(response.ok)
    #expect(response.result?.guardrailsActive == true)

    await safety.emit(.init(type: .killSwitch, timestampMs: 9))
    let events = await received.values()
    #expect(events.map(\.event) == [.killSwitch])

    let blocked = await service.handle(.init(
        requestId: "blocked-click",
        command: .actClick(.init(position: .init(x: 1, y: 2)))
    ))
    #expect(blocked.error?.code == .safetyInterlockEngaged)

    let unsubscribe = await service.handle(.init(
        requestId: "unsubscribe",
        command: .guardrailsUnsubscribe(.init())
    ))
    #expect(unsubscribe.ok)
    #expect(unsubscribe.result?.guardrailsActive == false)
}

@Test func guardrailCannotBeLostWhileSubscriptionIsStarting() async {
    let safety = FakeSafetyMonitor(eventOnStart: .init(type: .killSwitch, timestampMs: 0))
    let received = SafetyEventCollector()
    let service = SidecarService(
        recorder: FakeRecorder(),
        inputMonitor: FakeInputMonitor(),
        permissions: FakePermissions(),
        actions: FakeActions(),
        safetyMonitor: safety,
        safetyEventSink: { event in await received.append(event) }
    )

    let response = await service.handle(.init(
        requestId: "subscribe-race",
        command: .guardrailsSubscribe(.init())
    ))

    #expect(response.ok)
    #expect(response.result?.guardrailsTripped == true)
    #expect(await received.values().map(\.event) == [.killSwitch])
    let blocked = await service.handle(.init(
        requestId: "blocked-after-start",
        command: .actClick(.init(position: .init(x: 1, y: 2)))
    ))
    #expect(blocked.error?.code == .safetyInterlockEngaged)
}

private final class FakeRecorder: RecordingControlling, @unchecked Sendable {
    private let lock = NSLock()
    private let captureOrigin: UInt64
    private let startError: SidecarOperationError?
    private let stopError: SidecarOperationError?
    private var healthy: Bool

    init(
        captureOrigin: UInt64 = DispatchTime.now().uptimeNanoseconds,
        healthy: Bool = true,
        startError: SidecarOperationError? = nil,
        stopError: SidecarOperationError? = nil
    ) {
        self.captureOrigin = captureOrigin
        self.healthy = healthy
        self.startError = startError
        self.stopError = stopError
    }

    func start(configuration: RecordingStartConfiguration) async throws -> RecordingTiming {
        if let startError { throw startError }
        return RecordingTiming(captureOriginUptimeNanoseconds: captureOrigin)
    }
    func stop() async throws {
        if let stopError { throw stopError }
    }
    func isHealthy() async -> Bool { lock.withLock { healthy } }
    func setHealthy(_ healthy: Bool) { lock.withLock { self.healthy = healthy } }
}

private final class FakeInputMonitor: InputMonitoring, @unchecked Sendable {
    private let lock = NSLock()
    private let startError: SidecarOperationError?
    private var handler: InputEventHandler?
    private var timeOrigin: UInt64?

    init(startError: SidecarOperationError? = nil) {
        self.startError = startError
    }

    func start(
        sessionId: String,
        startedAtUptimeNanoseconds: UInt64,
        handler: @escaping InputEventHandler
    ) async throws {
        if let startError {
            throw startError
        }
        lock.withLock {
            self.handler = handler
            timeOrigin = startedAtUptimeNanoseconds
        }
    }

    func stop() async {}

    func emit(_ event: RawInputEvent, target: AccessibilityTarget?) async {
        let currentHandler = lock.withLock { handler }
        await currentHandler?(event, target)
    }

    func receivedTimeOrigin() -> UInt64? {
        lock.withLock { timeOrigin }
    }
}

private final class FakePermissions: PermissionProviding, Sendable {
    private let configuredStates: [PermissionKind: PermissionState]

    init(states: [PermissionKind: PermissionState] = [
        .screenRecording: .granted,
        .accessibility: .granted,
        .inputMonitoring: .granted,
        .microphone: .granted
    ]) {
        configuredStates = states
    }

    func snapshot() async -> PermissionSnapshot {
        PermissionSnapshot(states: configuredStates)
    }

    func request(_ permission: PermissionKind) async -> PermissionState {
        configuredStates[permission] ?? .unknown
    }

    func openSystemSettings(for permission: PermissionKind) async throws {}
}

private actor FakeActions: ActionPerforming {
    private let focusedSecure: Bool
    private var typed: [String] = []
    private var clicks = 0
    private var keys = 0
    private var scrolls = 0
    private var drags = 0
    private var navigations = 0

    init(focusedSecure: Bool = false) {
        self.focusedSecure = focusedSecure
    }

    func screenshot(to outputURL: URL, displayId: UInt32?) async throws -> ScreenshotResult {
        ScreenshotResult(path: outputURL.path, width: 100, height: 50, scale: 2)
    }

    func click(_ command: ActClickCommand) async throws {
        clicks += 1
    }

    func isFocusedElementSecure() async throws -> Bool {
        focusedSecure
    }

    func typeText(_ text: String, target: ElementSelector?) async throws {
        typed.append(text)
    }

    func pressKey(_ command: ActKeyCommand) async throws { keys += 1 }

    func scroll(_ command: ActScrollCommand) async throws { scrolls += 1 }

    func drag(_ command: ActDragCommand) async throws { drags += 1 }

    func navigate(_ command: ActNavigateCommand) async throws { navigations += 1 }

    func typedTexts() -> [String] { typed }

    func actionCounts() -> (keys: Int, scrolls: Int, drags: Int, navigations: Int) {
        (keys, scrolls, drags, navigations)
    }
}

private final class FakeSafetyMonitor: SafetyMonitoring, @unchecked Sendable {
    private var handler: SafetyEventHandler?
    private let eventOnStart: SidecarSafetyEvent?

    init(eventOnStart: SidecarSafetyEvent? = nil) {
        self.eventOnStart = eventOnStart
    }

    func start(
        configuration: GuardrailsSubscribeCommand,
        handler: @escaping SafetyEventHandler
    ) async throws {
        self.handler = handler
        if let eventOnStart {
            await handler(eventOnStart)
        }
    }

    func stop() async {
        handler = nil
    }

    func emit(_ event: SidecarSafetyEvent) async {
        await handler?(event)
    }
}

private actor SafetyEventCollector {
    private var events: [SidecarEventEnvelope] = []

    func append(_ event: SidecarEventEnvelope) {
        events.append(event)
    }

    func values() -> [SidecarEventEnvelope] {
        events
    }
}
