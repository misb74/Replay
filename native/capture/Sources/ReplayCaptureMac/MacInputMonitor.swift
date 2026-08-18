import AppKit
import CoreGraphics
import Foundation
import ReplayCaptureCore

public final class MacInputMonitor: InputMonitoring, @unchecked Sendable {
    private struct MouseGesture {
        var start: CGPoint
        var button: MouseButton
        var dragged: Bool
    }

    private let lock = NSLock()
    private let runLoopGroup = DispatchGroup()
    private var handler: InputEventHandler?
    private var sessionId = ""
    private var startedAtNanos: UInt64 = 0
    private var tap: CFMachPort?
    private var runLoop: CFRunLoop?
    private var thread: Thread?
    private var workspaceObserver: NSObjectProtocol?
    private var deliveryTail: Task<Void, Never>?
    private var gesture: MouseGesture?
    private var lastBundleId: String?
    private var lastWindowTitle: String?

    public init() {}

    public func start(
        sessionId: String,
        startedAtUptimeNanoseconds: UInt64,
        handler: @escaping InputEventHandler
    ) async throws {
        let alreadyRunning = lock.replayWithLock {
            let running = tap != nil || thread != nil
            if !running {
                self.sessionId = sessionId
                self.startedAtNanos = startedAtUptimeNanoseconds
                self.handler = handler
            }
            return running
        }
        guard !alreadyRunning else {
            throw SidecarOperationError.invalidState("Input monitoring is already active.")
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

                let mask = Self.eventMask
                guard let tap = CGEvent.tapCreate(
                    tap: .cgSessionEventTap,
                    place: .headInsertEventTap,
                    options: .listenOnly,
                    eventsOfInterest: mask,
                    callback: Self.eventTapCallback,
                    userInfo: Unmanaged.passUnretained(self).toOpaque()
                ) else {
                    self.clearState()
                    continuation.resume(throwing: SidecarOperationError.permissionDenied(.inputMonitoring))
                    return
                }

                let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
                let runLoop = CFRunLoopGetCurrent()
                self.lock.lock()
                self.tap = tap
                self.runLoop = runLoop
                self.lock.unlock()

                let observer = NSWorkspace.shared.notificationCenter.addObserver(
                    forName: NSWorkspace.didActivateApplicationNotification,
                    object: nil,
                    queue: nil
                ) { [weak self] notification in
                    self?.applicationActivated(notification)
                }
                self.lock.replayWithLock { self.workspaceObserver = observer }

                CFRunLoopAddSource(runLoop, source, .commonModes)
                CGEvent.tapEnable(tap: tap, enable: true)
                continuation.resume()
                CFRunLoopRun()
                CGEvent.tapEnable(tap: tap, enable: false)
                CFRunLoopRemoveSource(runLoop, source, .commonModes)
                NSWorkspace.shared.notificationCenter.removeObserver(observer)
                self.clearState()
            }
            thread.name = "Replay input monitor"
            lock.lock()
            self.thread = thread
            lock.unlock()
            thread.start()
        }
    }

    public func stop() async {
        let state = lock.replayWithLock {
            let current = self.runLoop
            handler = nil
            return (current, deliveryTail)
        }
        if let runLoop = state.0 {
            CFRunLoopStop(runLoop)
        } else {
            clearState()
        }
        if let deliveryTail = state.1 {
            await deliveryTail.value
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
            .leftMouseDown, .leftMouseDragged, .leftMouseUp,
            .rightMouseDown, .rightMouseDragged, .rightMouseUp,
            .otherMouseDown, .otherMouseDragged, .otherMouseUp,
            .scrollWheel
        ]
        return types.reduce(CGEventMask(0)) { partial, type in
            partial | (CGEventMask(1) << CGEventMask(type.rawValue))
        }
    }()

    private static let eventTapCallback: CGEventTapCallBack = { _, type, event, userInfo in
        guard let userInfo else { return Unmanaged.passUnretained(event) }
        let monitor = Unmanaged<MacInputMonitor>.fromOpaque(userInfo).takeUnretainedValue()

        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            monitor.enableTap()
            return Unmanaged.passUnretained(event)
        }

        monitor.process(type: type, event: event)
        return Unmanaged.passUnretained(event)
    }

    private func process(type: CGEventType, event: CGEvent) {
        if event.getIntegerValueField(.eventSourceUserData) == replaySyntheticEventMarker {
            return
        }
        let state: (String, UInt64, Bool) = lock.replayWithLock {
            (self.sessionId, self.startedAtNanos, self.handler != nil)
        }
        let sessionId = state.0
        let startedAtNanos = state.1
        guard state.2 else { return }

        let eventNanos = event.timestamp
        let timestampMs = Double(eventNanos >= startedAtNanos ? eventNanos - startedAtNanos : 0) / 1_000_000
        let point = event.location
        let target: AccessibilityTarget?
        switch type {
        case .keyDown:
            target = MacAccessibility.snapshot(at: nil)
        default:
            target = MacAccessibility.snapshot(at: point)
        }

        emitContextChanges(
            target: target,
            sessionId: sessionId,
            timestampMs: timestampMs
        )

        let raw: RawInputEvent?
        switch type {
        case .keyDown:
            raw = .key(
                id: UUID().uuidString,
                sessionId: sessionId,
                timestampMs: timestampMs,
                keyCode: UInt16(event.getIntegerValueField(.keyboardEventKeycode)),
                text: keyboardText(from: event),
                modifiers: modifierKeys(from: event.flags)
            )
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            gesture = MouseGesture(start: point, button: mouseButton(for: type), dragged: false)
            raw = nil
        case .leftMouseDragged, .rightMouseDragged, .otherMouseDragged:
            gesture?.dragged = true
            raw = nil
        case .leftMouseUp, .rightMouseUp, .otherMouseUp:
            let current = gesture
            gesture = nil
            if let current, current.dragged {
                raw = .drag(
                    id: UUID().uuidString,
                    sessionId: sessionId,
                    timestampMs: timestampMs,
                    start: Point(x: current.start.x, y: current.start.y),
                    end: Point(x: point.x, y: point.y),
                    button: current.button
                )
            } else {
                raw = .click(
                    id: UUID().uuidString,
                    sessionId: sessionId,
                    timestampMs: timestampMs,
                    position: Point(x: point.x, y: point.y),
                    button: current?.button ?? mouseButton(for: type),
                    clickCount: max(1, Int(event.getIntegerValueField(.mouseEventClickState)))
                )
            }
        case .scrollWheel:
            raw = .scroll(
                id: UUID().uuidString,
                sessionId: sessionId,
                timestampMs: timestampMs,
                position: Point(x: point.x, y: point.y),
                deltaX: event.getDoubleValueField(.scrollWheelEventPointDeltaAxis2),
                deltaY: event.getDoubleValueField(.scrollWheelEventPointDeltaAxis1)
            )
        default:
            raw = nil
        }

        if let raw {
            schedule(raw, target: target)
        }
    }

    private func emitContextChanges(
        target: AccessibilityTarget?,
        sessionId: String,
        timestampMs: Double
    ) {
        let changes: (app: Bool, window: Bool) = lock.replayWithLock {
            var appChanged = false
            var windowChanged = false
            if let bundleId = target?.bundleId, bundleId != lastBundleId {
                lastBundleId = bundleId
                appChanged = true
            }
            if let title = target?.windowTitle, title != lastWindowTitle {
                lastWindowTitle = title
                windowChanged = true
            }
            return (appChanged, windowChanged)
        }
        if changes.app {
            schedule(.appSwitch(
                id: UUID().uuidString,
                sessionId: sessionId,
                timestampMs: timestampMs
            ), target: target)
        }
        if changes.window {
            schedule(.windowSwitch(
                id: UUID().uuidString,
                sessionId: sessionId,
                timestampMs: timestampMs
            ), target: target)
        }
    }

    private func applicationActivated(_ notification: Notification) {
        let state: (String, UInt64, Bool) = lock.replayWithLock {
            (self.sessionId, self.startedAtNanos, self.handler != nil)
        }
        guard state.2 else { return }
        let now = DispatchTime.now().uptimeNanoseconds
        let timestampMs = Double(now >= state.1 ? now - state.1 : 0) / 1_000_000
        let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey]
            as? NSRunningApplication
        var target = MacAccessibility.snapshot(at: nil) ?? AccessibilityTarget()
        if let bundleId = application?.bundleIdentifier {
            target.bundleId = bundleId
        }
        lock.replayWithLock {
            lastBundleId = target.bundleId
            lastWindowTitle = target.windowTitle
        }
        schedule(.appSwitch(
            id: UUID().uuidString,
            sessionId: state.0,
            timestampMs: timestampMs
        ), target: target)
    }

    private func schedule(_ event: RawInputEvent, target: AccessibilityTarget?) {
        lock.replayWithLock {
            guard let handler else { return }
            let previous = deliveryTail
            deliveryTail = Task {
                if let previous {
                    await previous.value
                }
                await handler(event, target)
            }
        }
    }

    private func keyboardText(from event: CGEvent) -> String? {
        var count = 0
        var characters = [UniChar](repeating: 0, count: 64)
        event.keyboardGetUnicodeString(
            maxStringLength: characters.count,
            actualStringLength: &count,
            unicodeString: &characters
        )
        guard count > 0 else { return nil }
        return String(utf16CodeUnits: characters, count: count)
    }

    private func modifierKeys(from flags: CGEventFlags) -> [ModifierKey] {
        var result: [ModifierKey] = []
        if flags.contains(.maskCommand) { result.append(.command) }
        if flags.contains(.maskControl) { result.append(.control) }
        if flags.contains(.maskAlternate) { result.append(.option) }
        if flags.contains(.maskShift) { result.append(.shift) }
        if flags.contains(.maskAlphaShift) { result.append(.capsLock) }
        if flags.contains(.maskSecondaryFn) { result.append(.function) }
        return result
    }

    private func mouseButton(for type: CGEventType) -> MouseButton {
        switch type {
        case .rightMouseDown, .rightMouseDragged, .rightMouseUp: return .right
        case .otherMouseDown, .otherMouseDragged, .otherMouseUp: return .other
        default: return .left
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
            workspaceObserver = nil
            deliveryTail = nil
            gesture = nil
            lastBundleId = nil
            lastWindowTitle = nil
        }
    }
}
