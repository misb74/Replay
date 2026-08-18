import CoreGraphics
import Darwin
import Foundation
import ReplayCaptureCore

public final class MacSafetyMonitor: SafetyMonitoring, @unchecked Sendable {
    private let safetyInterlock: SafetyInterlock
    private let lock = NSLock()
    private let deliveryGroup = DispatchGroup()
    private let runLoopGroup = DispatchGroup()
    private var handler: SafetyEventHandler?
    private var configuration = GuardrailsSubscribeCommand()
    private var tap: CFMachPort?
    private var runLoop: CFRunLoop?
    private var thread: Thread?
    private var startedAtNanos: UInt64 = 0
    private var lastMousePoint: CGPoint?
    private var lastMouseEventNanos: UInt64 = 0

    public init(safetyInterlock: SafetyInterlock = SafetyInterlock()) {
        self.safetyInterlock = safetyInterlock
    }

    public func start(
        configuration: GuardrailsSubscribeCommand,
        handler: @escaping SafetyEventHandler
    ) async throws {
        let initialMousePoint = CGEvent(source: nil)?.location
        let alreadyRunning = lock.replayWithLock {
            let running = tap != nil || thread != nil
            if !running {
                self.configuration = configuration
                self.handler = handler
                self.startedAtNanos = DispatchTime.now().uptimeNanoseconds
                self.lastMousePoint = initialMousePoint
                self.lastMouseEventNanos = 0
            }
            return running
        }
        guard !alreadyRunning else {
            throw SidecarOperationError.invalidState("Safety monitoring is already active.")
        }

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let runLoopGroup = self.runLoopGroup
            runLoopGroup.enter()
            let thread = Thread { [weak self] in
                defer { runLoopGroup.leave() }
                guard let self else {
                    continuation.resume(throwing: SidecarOperationError.captureFailed)
                    return
                }
                guard let tap = CGEvent.tapCreate(
                    tap: .cgSessionEventTap,
                    place: .headInsertEventTap,
                    options: .listenOnly,
                    eventsOfInterest: Self.eventMask,
                    callback: Self.eventTapCallback,
                    userInfo: Unmanaged.passUnretained(self).toOpaque()
                ) else {
                    self.clearState()
                    continuation.resume(throwing: SidecarOperationError.permissionDenied(.inputMonitoring))
                    return
                }

                let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
                let runLoop = CFRunLoopGetCurrent()
                self.lock.replayWithLock {
                    self.tap = tap
                    self.runLoop = runLoop
                }
                CFRunLoopAddSource(runLoop, source, .commonModes)
                CGEvent.tapEnable(tap: tap, enable: true)
                continuation.resume()
                CFRunLoopRun()
                CGEvent.tapEnable(tap: tap, enable: false)
                CFRunLoopRemoveSource(runLoop, source, .commonModes)
                self.clearState()
            }
            thread.name = "Replay safety monitor"
            lock.replayWithLock { self.thread = thread }
            thread.start()
        }
    }

    public func stop() async {
        let runLoop = lock.replayWithLock {
            let current = self.runLoop
            handler = nil
            return current
        }
        if let runLoop {
            CFRunLoopStop(runLoop)
        } else {
            clearState()
        }
        await withCheckedContinuation { continuation in
            deliveryGroup.notify(queue: .global(qos: .userInitiated)) {
                continuation.resume()
            }
        }
        await withCheckedContinuation { continuation in
            runLoopGroup.notify(queue: .global(qos: .userInitiated)) {
                continuation.resume()
            }
        }
    }

    private static let eventMask: CGEventMask = {
        let types: [CGEventType] = [
            .keyDown,
            .mouseMoved,
            .leftMouseDragged,
            .rightMouseDragged,
            .otherMouseDragged
        ]
        return types.reduce(CGEventMask(0)) { result, type in
            result | (CGEventMask(1) << CGEventMask(type.rawValue))
        }
    }()

    private static let eventTapCallback: CGEventTapCallBack = { _, type, event, userInfo in
        guard let userInfo else { return Unmanaged.passUnretained(event) }
        let monitor = Unmanaged<MacSafetyMonitor>.fromOpaque(userInfo).takeUnretainedValue()
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            monitor.enableTap()
        } else {
            monitor.process(type: type, event: event)
        }
        return Unmanaged.passUnretained(event)
    }

    private func process(type: CGEventType, event: CGEvent) {
        // Actions posted by this sidecar must not be mistaken for the user
        // taking control of the mouse.
        let sourcePid = pid_t(event.getIntegerValueField(.eventSourceUnixProcessID))
        let sourceMarker = event.getIntegerValueField(.eventSourceUserData)
        if sourcePid == getpid() || sourceMarker == replaySyntheticEventMarker { return }
        if safetyInterlock.isTripped { return }

        let state = lock.replayWithLock {
            (handler != nil, configuration, startedAtNanos)
        }
        guard state.0 else { return }
        let timestampMs = Double(
            event.timestamp >= state.2 ? event.timestamp - state.2 : 0
        ) / 1_000_000

        if type == .keyDown,
           UInt16(event.getIntegerValueField(.keyboardEventKeycode)) == state.1.killSwitch.keyCode,
           event.getIntegerValueField(.keyboardEventAutorepeat) == 0,
           Self.modifiersMatch(event.flags, expected: state.1.killSwitch.modifiers) {
            schedule(SidecarSafetyEvent(type: .killSwitch, timestampMs: timestampMs))
            return
        }

        guard type == .mouseMoved
                || type == .leftMouseDragged
                || type == .rightMouseDragged
                || type == .otherMouseDragged else {
            return
        }
        let point = event.location
        let shouldEmit = lock.replayWithLock { () -> Bool in
            guard let previous = lastMousePoint else {
                lastMousePoint = point
                return false
            }
            let distance = hypot(point.x - previous.x, point.y - previous.y)
            guard distance >= state.1.mouseMovementThreshold else { return false }
            // A short debounce avoids flooding stdout while still pausing a run
            // on the first deliberate user movement.
            guard event.timestamp >= lastMouseEventNanos + 100_000_000 else { return false }
            lastMousePoint = point
            lastMouseEventNanos = event.timestamp
            return true
        }
        if shouldEmit {
            schedule(SidecarSafetyEvent(
                type: .userMouseMoved,
                timestampMs: timestampMs,
                position: Point(x: point.x, y: point.y)
            ))
        }
    }

    private func schedule(_ event: SidecarSafetyEvent) {
        safetyInterlock.trip()
        let currentHandler: SafetyEventHandler? = lock.replayWithLock {
            guard let handler else { return nil }
            deliveryGroup.enter()
            return handler
        }
        guard let currentHandler else { return }
        Task {
            await currentHandler(event)
            deliveryGroup.leave()
        }
    }

    static func modifiersMatch(_ flags: CGEventFlags, expected: [ModifierKey]) -> Bool {
        let relevant: [(ModifierKey, CGEventFlags)] = [
            (.command, .maskCommand),
            (.control, .maskControl),
            (.option, .maskAlternate),
            (.shift, .maskShift),
            (.capsLock, .maskAlphaShift),
            (.function, .maskSecondaryFn)
        ]
        let expectedSet = Set(expected)
        return relevant.allSatisfy { modifier, flag in
            !expectedSet.contains(modifier) || flags.contains(flag)
        }
    }

    private func enableTap() {
        let tap = lock.replayWithLock { self.tap }
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: true)
        }
    }

    private func clearState() {
        lock.replayWithLock {
            handler = nil
            tap = nil
            runLoop = nil
            thread = nil
            lastMousePoint = nil
            lastMouseEventNanos = 0
        }
    }
}
