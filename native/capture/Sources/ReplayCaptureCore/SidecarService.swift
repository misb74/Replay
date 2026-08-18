import Foundation

public struct RecordingStartConfiguration: Equatable, Sendable {
    public var videoURL: URL
    public var audioURL: URL?
    public var displayId: UInt32?

    public init(
        videoURL: URL,
        audioURL: URL?,
        displayId: UInt32?
    ) {
        self.videoURL = videoURL
        self.audioURL = audioURL
        self.displayId = displayId
    }
}

public struct RecordingTiming: Equatable, Sendable {
    public var captureOriginUptimeNanoseconds: UInt64

    public init(captureOriginUptimeNanoseconds: UInt64) {
        self.captureOriginUptimeNanoseconds = captureOriginUptimeNanoseconds
    }
}

public protocol RecordingControlling: AnyObject, Sendable {
    func start(configuration: RecordingStartConfiguration) async throws -> RecordingTiming
    func stop() async throws
    func isHealthy() async -> Bool
}

public typealias InputEventHandler = @Sendable (RawInputEvent, AccessibilityTarget?) async -> Void

public protocol InputMonitoring: AnyObject, Sendable {
    func start(
        sessionId: String,
        startedAtUptimeNanoseconds: UInt64,
        handler: @escaping InputEventHandler
    ) async throws
    func stop() async
}

public protocol ActionPerforming: AnyObject, Sendable {
    func screenshot(to outputURL: URL, displayId: UInt32?) async throws -> ScreenshotResult
    func click(_ command: ActClickCommand) async throws
    func isFocusedElementSecure() async throws -> Bool
    func typeText(_ text: String, target: ElementSelector?) async throws
    func pressKey(_ command: ActKeyCommand) async throws
    func scroll(_ command: ActScrollCommand) async throws
    func drag(_ command: ActDragCommand) async throws
    func navigate(_ command: ActNavigateCommand) async throws
}

public typealias SafetyEventHandler = @Sendable (SidecarSafetyEvent) async -> Void

public protocol SafetyMonitoring: AnyObject, Sendable {
    func start(
        configuration: GuardrailsSubscribeCommand,
        handler: @escaping SafetyEventHandler
    ) async throws
    func stop() async
}

public extension ActionPerforming {
    func screenshot(to outputURL: URL) async throws -> ScreenshotResult {
        try await screenshot(to: outputURL, displayId: nil)
    }

    func typeText(_ text: String) async throws {
        try await typeText(text, target: nil)
    }
}

public enum SidecarOperationError: Error, Equatable {
    case invalidState(String)
    case permissionDenied(PermissionKind)
    case secureFieldRequiresHumanInput
    case safetyInterlockEngaged
    case targetNotFound
    case noVideoFrames
    case captureFailed
    case ioFailed
}

private actor ActiveRecordingSession {
    let sessionId: String
    let writer: SessionWriter
    private var writeFailed = false

    init(sessionId: String, writer: SessionWriter) {
        self.sessionId = sessionId
        self.writer = writer
    }

    func ingest(_ raw: RawInputEvent, target: AccessibilityTarget?) async {
        guard !writeFailed else { return }
        let event = EventSanitizer.sanitize(raw, target: target)
        do {
            try await writer.append(event)
        } catch {
            writeFailed = true
            try? await writer.markInterrupted(reason: "event_write_failed")
        }
    }

    func metadata() async -> SessionMetadata {
        await writer.currentMetadata()
    }

    func isHealthy() -> Bool {
        !writeFailed
    }
}

public actor SidecarService {
    private let recorder: RecordingControlling
    private let inputMonitor: InputMonitoring
    private let permissions: PermissionProviding
    private let actions: ActionPerforming
    private let safetyMonitor: SafetyMonitoring?
    private let safetyInterlock: SafetyInterlock
    private let safetyEventSink: @Sendable (SidecarEventEnvelope) async -> Void
    private let monotonicNow: @Sendable () -> UInt64
    private let launchedAtNanoseconds: UInt64
    private var active: ActiveRecordingSession?
    private var guardrailsActive = false
    private var guardrailsTripped = false

    public init(
        recorder: RecordingControlling,
        inputMonitor: InputMonitoring,
        permissions: PermissionProviding,
        actions: ActionPerforming,
        safetyMonitor: SafetyMonitoring? = nil,
        safetyInterlock: SafetyInterlock = SafetyInterlock(),
        safetyEventSink: @escaping @Sendable (SidecarEventEnvelope) async -> Void = { _ in },
        monotonicNow: @escaping @Sendable () -> UInt64 = { DispatchTime.now().uptimeNanoseconds }
    ) {
        self.recorder = recorder
        self.inputMonitor = inputMonitor
        self.permissions = permissions
        self.actions = actions
        self.safetyMonitor = safetyMonitor
        self.safetyInterlock = safetyInterlock
        self.safetyEventSink = safetyEventSink
        self.monotonicNow = monotonicNow
        self.launchedAtNanoseconds = monotonicNow()
    }

    public func handle(_ envelope: SidecarCommandEnvelope) async -> SidecarResponse {
        do {
            let result: SidecarResponseResult
            switch envelope.command {
            case let .record(command):
                result = try await startRecording(command)
            case let .stop(command):
                result = try await stopRecording(command)
            case .status:
                result = await status()
            case let .permissions(command):
                result = try await handlePermissions(command)
            case let .actScreenshot(command):
                try await requirePermission(.screenRecording)
                let screenshot = try await actions.screenshot(
                    to: URL(fileURLWithPath: command.outputPath),
                    displayId: command.displayId
                )
                result = SidecarResponseResult(type: .screenshot, screenshot: screenshot)
            case let .actClick(command):
                try ensureSafetyInterlockClear()
                try await requirePermission(.accessibility)
                if let position = command.position {
                    guard position.x.isFinite, position.y.isFinite else {
                        throw SidecarOperationError.invalidState("Click coordinates must be finite.")
                    }
                }
                try await actions.click(command)
                result = SidecarResponseResult(type: .actionCompleted)
            case let .actType(command):
                try ensureSafetyInterlockClear()
                try await requirePermission(.accessibility)
                if command.target == nil {
                    guard try await !actions.isFocusedElementSecure() else {
                        throw SidecarOperationError.secureFieldRequiresHumanInput
                    }
                }
                try await actions.typeText(command.text, target: command.target)
                result = SidecarResponseResult(type: .actionCompleted)
            case let .actKey(command):
                try ensureSafetyInterlockClear()
                try await requirePermission(.accessibility)
                guard (1...100).contains(command.repeatCount) else {
                    throw SidecarOperationError.invalidState("The key repeat count must be between 1 and 100.")
                }
                guard try await !actions.isFocusedElementSecure() else {
                    throw SidecarOperationError.secureFieldRequiresHumanInput
                }
                try await actions.pressKey(command)
                result = SidecarResponseResult(type: .actionCompleted)
            case let .actScroll(command):
                try ensureSafetyInterlockClear()
                try await requirePermission(.accessibility)
                guard command.deltaX.isFinite, command.deltaY.isFinite else {
                    throw SidecarOperationError.invalidState("Scroll deltas must be finite.")
                }
                try await actions.scroll(command)
                result = SidecarResponseResult(type: .actionCompleted)
            case let .actDrag(command):
                try ensureSafetyInterlockClear()
                try await requirePermission(.accessibility)
                guard (0...10_000).contains(command.durationMs) else {
                    throw SidecarOperationError.invalidState("The drag duration must be between 0 and 10000 milliseconds.")
                }
                guard command.start.x.isFinite,
                      command.start.y.isFinite,
                      command.end.x.isFinite,
                      command.end.y.isFinite else {
                    throw SidecarOperationError.invalidState("Drag coordinates must be finite.")
                }
                try await actions.drag(command)
                result = SidecarResponseResult(type: .actionCompleted)
            case let .actNavigate(command):
                try ensureSafetyInterlockClear()
                try await requirePermission(.accessibility)
                guard command.isValidHTTPURL else {
                    throw SidecarOperationError.invalidState("Navigation requires an HTTP or HTTPS URL.")
                }
                try await actions.navigate(command)
                result = SidecarResponseResult(type: .actionCompleted)
            case let .heartbeat(command):
                let now = monotonicNow()
                let elapsed = now >= launchedAtNanoseconds
                    ? now - launchedAtNanoseconds
                    : 0
                let healthy: Bool
                if let active {
                    let eventStorageHealthy = await active.isHealthy()
                    let recorderHealthy = await recorder.isHealthy()
                    healthy = eventStorageHealthy && recorderHealthy
                } else {
                    healthy = true
                }
                result = SidecarResponseResult(
                    type: .heartbeat,
                    state: active == nil ? .idle : .recording,
                    nonce: command.nonce,
                    uptimeMs: Double(elapsed) / 1_000_000,
                    captureHealthy: healthy
                )
            case let .guardrailsSubscribe(command):
                result = try await subscribeToGuardrails(command)
            case .guardrailsUnsubscribe:
                await safetyMonitor?.stop()
                guardrailsActive = false
                guardrailsTripped = false
                safetyInterlock.reset()
                result = SidecarResponseResult(
                    type: .guardrailsUnsubscribed,
                    guardrailsActive: false,
                    guardrailsTripped: false
                )
            }
            return .success(requestId: envelope.requestId, result: result)
        } catch let error as SidecarOperationError {
            return response(for: error, requestId: envelope.requestId)
        } catch is SessionWriterError {
            return .failure(
                requestId: envelope.requestId,
                code: .ioFailed,
                message: "The recording session could not be written."
            )
        } catch {
            return .failure(
                requestId: envelope.requestId,
                code: .internalError,
                message: "The sidecar could not complete the command."
            )
        }
    }

    public func shutdown() async {
        await safetyMonitor?.stop()
        guardrailsActive = false
        guardrailsTripped = false
        safetyInterlock.reset()
        if let active {
            await inputMonitor.stop()
            try? await recorder.stop()
            try? await active.writer.markInterrupted(reason: "sidecar_shutdown")
            self.active = nil
        }
    }

    public func flushPendingEventsForTesting() async {
        guard let active else { return }
        _ = await active.metadata()
    }

    private func startRecording(_ command: RecordCommand) async throws -> SidecarResponseResult {
        guard active == nil else {
            throw SidecarOperationError.invalidState("A recording is already active.")
        }
        try await requirePermission(.screenRecording)
        try await requirePermission(.accessibility)
        try await requirePermission(.inputMonitoring)
        if command.includeAudio {
            try await requirePermission(.microphone)
        }

        let directory = URL(fileURLWithPath: command.sessionDirectory, isDirectory: true)
        var appVersions = command.appVersions
        appVersions["captureSidecar"] = ReplayCaptureBuildInfo.version
        let configuration = SessionConfiguration(
            sessionId: command.sessionId,
            directory: directory,
            includeAudio: command.includeAudio,
            display: command.display,
            appVersions: appVersions
        )
        let writer: SessionWriter
        do {
            writer = try await SessionWriter.create(configuration: configuration)
        } catch {
            throw SidecarOperationError.ioFailed
        }
        let runtime = ActiveRecordingSession(sessionId: command.sessionId, writer: writer)
        do {
            let timing = try await recorder.start(configuration: RecordingStartConfiguration(
                videoURL: directory.appendingPathComponent(SessionWriter.videoFileName),
                audioURL: command.includeAudio
                    ? directory.appendingPathComponent(SessionWriter.audioFileName)
                    : nil,
                displayId: command.display.displayId
            ))
            try await inputMonitor.start(
                sessionId: command.sessionId,
                startedAtUptimeNanoseconds: timing.captureOriginUptimeNanoseconds
            ) { raw, target in
                await runtime.ingest(raw, target: target)
            }
            guard await recorder.isHealthy() else {
                throw SidecarOperationError.captureFailed
            }
            active = runtime
        } catch {
            await inputMonitor.stop()
            try? await recorder.stop()
            let interruptionReason = error as? SidecarOperationError == .noVideoFrames
                ? "no_video_frames"
                : "capture_start_failed"
            try? await writer.markInterrupted(reason: interruptionReason)
            if let operationError = error as? SidecarOperationError {
                throw operationError
            }
            throw SidecarOperationError.captureFailed
        }

        return SidecarResponseResult(
            type: .recordingStarted,
            state: .recording,
            sessionId: command.sessionId,
            eventCount: 0,
            partial: true,
            captureHealthy: true
        )
    }

    private func stopRecording(_ command: StopCommand) async throws -> SidecarResponseResult {
        guard let active else {
            throw SidecarOperationError.invalidState("No recording is active.")
        }
        if let requested = command.sessionId, requested != active.sessionId {
            throw SidecarOperationError.invalidState("The requested session is not active.")
        }

        await inputMonitor.stop()
        let eventStorageHealthy = await active.isHealthy()
        let recorderHealthy = await recorder.isHealthy()
        do {
            try await recorder.stop()
            guard eventStorageHealthy else {
                self.active = nil
                throw SidecarOperationError.ioFailed
            }
            guard recorderHealthy else {
                self.active = nil
                throw SidecarOperationError.captureFailed
            }
            do {
                try await active.writer.finish()
            } catch {
                throw SidecarOperationError.ioFailed
            }
        } catch {
            let interruptionReason = error as? SidecarOperationError == .noVideoFrames
                ? "no_video_frames"
                : "capture_stop_failed"
            try? await active.writer.markInterrupted(reason: interruptionReason)
            self.active = nil
            if let operationError = error as? SidecarOperationError {
                throw operationError
            }
            throw SidecarOperationError.captureFailed
        }

        let metadata = await active.writer.currentMetadata()
        self.active = nil
        return SidecarResponseResult(
            type: .recordingStopped,
            state: .idle,
            sessionId: active.sessionId,
            eventCount: metadata.eventCount,
            partial: false
        )
    }

    private func status() async -> SidecarResponseResult {
        guard let active else {
            return SidecarResponseResult(
                type: .status,
                state: .idle,
                guardrailsActive: guardrailsActive,
                guardrailsTripped: guardrailsTripped,
                captureHealthy: true
            )
        }
        let metadata = await active.metadata()
        let eventStorageHealthy = await active.isHealthy()
        let recorderHealthy = await recorder.isHealthy()
        return SidecarResponseResult(
            type: .status,
            state: .recording,
            sessionId: active.sessionId,
            eventCount: metadata.eventCount,
            partial: metadata.partial,
            guardrailsActive: guardrailsActive,
            guardrailsTripped: guardrailsTripped,
            captureHealthy: eventStorageHealthy && recorderHealthy
        )
    }

    private func subscribeToGuardrails(
        _ command: GuardrailsSubscribeCommand
    ) async throws -> SidecarResponseResult {
        guard command.mouseMovementThreshold.isFinite,
              command.mouseMovementThreshold > 0 else {
            throw SidecarOperationError.invalidState("The mouse movement threshold must be positive.")
        }
        try await requirePermission(.inputMonitoring)
        guard let safetyMonitor else {
            throw SidecarOperationError.invalidState("Safety monitoring is not available.")
        }
        if guardrailsActive {
            await safetyMonitor.stop()
            guardrailsActive = false
        }
        guardrailsTripped = false
        safetyInterlock.reset()
        // Mark the subscription active before the monitor starts. Its event
        // tap can observe an emergency gesture immediately after installation,
        // while this actor is suspended in `start`.
        guardrailsActive = true
        do {
            try await safetyMonitor.start(configuration: command) { [weak self] event in
                await self?.receiveSafetyEvent(event)
            }
        } catch {
            guardrailsActive = false
            guardrailsTripped = false
            safetyInterlock.reset()
            throw error
        }
        return SidecarResponseResult(
            type: .guardrailsSubscribed,
            guardrailsActive: true,
            guardrailsTripped: guardrailsTripped
        )
    }

    private func receiveSafetyEvent(_ event: SidecarSafetyEvent) async {
        guard guardrailsActive else { return }
        guardrailsTripped = true
        safetyInterlock.trip()
        await safetyEventSink(SidecarEventEnvelope(event))
    }

    private func ensureSafetyInterlockClear() throws {
        try safetyInterlock.check()
    }

    private func handlePermissions(_ command: PermissionsCommand) async throws -> SidecarResponseResult {
        switch command.operation {
        case .status:
            break
        case .request:
            guard let permission = command.permission else {
                throw SidecarOperationError.invalidState("A permission must be named.")
            }
            _ = await permissions.request(permission)
        case .openSettings:
            guard let permission = command.permission else {
                throw SidecarOperationError.invalidState("A permission must be named.")
            }
            try await permissions.openSystemSettings(for: permission)
        }
        return SidecarResponseResult(
            type: .permissions,
            permissions: await permissions.snapshot()
        )
    }

    private func requirePermission(_ permission: PermissionKind) async throws {
        guard await permissions.snapshot()[permission] == .granted else {
            throw SidecarOperationError.permissionDenied(permission)
        }
    }

    private func response(
        for error: SidecarOperationError,
        requestId: String
    ) -> SidecarResponse {
        switch error {
        case let .invalidState(message):
            return .failure(requestId: requestId, code: .invalidState, message: message)
        case let .permissionDenied(permission):
            return .failure(
                requestId: requestId,
                code: .permissionDenied,
                message: "The \(permission.rawValue) permission is required."
            )
        case .secureFieldRequiresHumanInput:
            return .failure(
                requestId: requestId,
                code: .secureFieldRequiresHumanInput,
                message: "Secure fields must be typed by the user."
            )
        case .safetyInterlockEngaged:
            return .failure(
                requestId: requestId,
                code: .safetyInterlockEngaged,
                message: "A safety guardrail paused native actions."
            )
        case .targetNotFound:
            return .failure(requestId: requestId, code: .targetNotFound, message: "The target was not found.")
        case .noVideoFrames:
            return .failure(
                requestId: requestId,
                code: .captureFailed,
                message: "macOS did not provide any video frames. Check Screen Recording permission and try again."
            )
        case .captureFailed:
            return .failure(requestId: requestId, code: .captureFailed, message: "Capture could not continue.")
        case .ioFailed:
            return .failure(requestId: requestId, code: .ioFailed, message: "A session file could not be written.")
        }
    }
}
