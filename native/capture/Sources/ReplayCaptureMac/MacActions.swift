import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ReplayCaptureCore
import ScreenCaptureKit

public final class MacActionPerformer: ActionPerforming, Sendable {
    private let safetyInterlock: SafetyInterlock

    public init(safetyInterlock: SafetyInterlock = SafetyInterlock()) {
        self.safetyInterlock = safetyInterlock
    }

    public func screenshot(
        to outputURL: URL,
        displayId: UInt32?
    ) async throws -> ScreenshotResult {
        guard #available(macOS 14.0, *) else {
            throw SidecarOperationError.captureFailed
        }
        let display: SCDisplay
        let image: CGImage
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: true
            )
            let selected: SCDisplay?
            if let requestedId = displayId {
                selected = content.displays.first(where: { $0.displayID == requestedId })
            } else {
                selected = content.displays.first(where: { $0.displayID == CGMainDisplayID() })
                    ?? content.displays.first
            }
            guard let selected else {
                throw SidecarOperationError.captureFailed
            }
            display = selected

            let filter = SCContentFilter(
                display: selected,
                excludingApplications: [],
                exceptingWindows: []
            )
            let configuration = SCStreamConfiguration()
            configuration.width = selected.width
            configuration.height = selected.height
            configuration.showsCursor = true
            image = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: configuration
            )
        } catch let operationError as SidecarOperationError {
            throw operationError
        } catch {
            throw SidecarOperationError.captureFailed
        }

        let parent = outputURL.deletingLastPathComponent()
        guard let png = NSBitmapImageRep(cgImage: image).representation(
            using: .png,
            properties: [:]
        ) else {
            throw SidecarOperationError.ioFailed
        }
        do {
            try FileManager.default.createDirectory(
                at: parent,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            try png.write(to: outputURL, options: .atomic)
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: outputURL.path
            )
        } catch {
            throw SidecarOperationError.ioFailed
        }

        let screen = NSScreen.screens.first(where: { screen in
            (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
                == display.displayID
        })
        let scale = screenshotCoordinateScale(
            imageWidth: image.width,
            imageHeight: image.height,
            logicalWidth: screen.map { Double($0.frame.width) },
            logicalHeight: screen.map { Double($0.frame.height) },
            fallback: screen.map { Double($0.backingScaleFactor) } ?? 1
        )
        return ScreenshotResult(
            path: outputURL.path,
            width: image.width,
            height: image.height,
            scale: scale
        )
    }

    public func click(_ command: ActClickCommand) async throws {
        try safetyInterlock.check()
        if let target = command.target, let element = MacAccessibility.resolve(target) {
            try safetyInterlock.check()
            if command.button == .left,
               command.clickCount == 1,
               AXUIElementPerformAction(element, kAXPressAction as CFString) == .success {
                return
            }
            if let center = MacAccessibility.center(of: element) {
                try postClick(at: center, button: command.button, clickCount: command.clickCount)
                return
            }
        }

        guard let position = command.position else {
            throw SidecarOperationError.targetNotFound
        }
        try postClick(
            at: CGPoint(x: position.x, y: position.y),
            button: command.button,
            clickCount: command.clickCount
        )
    }

    public func isFocusedElementSecure() async throws -> Bool {
        MacAccessibility.focusedElementIsSecure()
    }

    public func typeText(_ text: String, target: ElementSelector?) async throws {
        try safetyInterlock.check()
        var expectedFocusedElement: AXUIElement?
        if let target {
            guard let element = MacAccessibility.resolve(target) else {
                throw SidecarOperationError.targetNotFound
            }
            try safetyInterlock.check()
            guard !MacAccessibility.isSecure(element) else {
                throw SidecarOperationError.secureFieldRequiresHumanInput
            }
            guard MacAccessibility.activateApplication(owning: element) else {
                throw SidecarOperationError.targetNotFound
            }
            try safetyInterlock.check()
            let result = AXUIElementSetAttributeValue(
                element,
                kAXFocusedAttribute as CFString,
                kCFBooleanTrue
            )
            guard result == .success else {
                throw SidecarOperationError.targetNotFound
            }
            expectedFocusedElement = element
        }

        // Re-check after focusing because a semantic target can differ from the
        // element that was focused when the command arrived. For targeted
        // typing, also require the requested element to be the actual focus.
        guard try await focusedElementIsSafeForTyping(
            matching: expectedFocusedElement
        ) else {
            throw SidecarOperationError.secureFieldRequiresHumanInput
        }
        try safetyInterlock.check()

        guard let source = CGEventSource(stateID: .hidSystemState),
              let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
            throw SidecarOperationError.captureFailed
        }

        // CGEvent accepts at most a short UTF-16 buffer reliably. Keeping each
        // chunk local also avoids placing the text on the system pasteboard.
        let units = Array(text.utf16)
        for offset in stride(from: 0, to: units.count, by: 20) {
            try safetyInterlock.check()
            let end = min(offset + 20, units.count)
            let chunk = Array(units[offset..<end])
            chunk.withUnsafeBufferPointer { buffer in
                keyDown.keyboardSetUnicodeString(
                    stringLength: buffer.count,
                    unicodeString: buffer.baseAddress
                )
                keyUp.keyboardSetUnicodeString(
                    stringLength: buffer.count,
                    unicodeString: buffer.baseAddress
                )
            }
            keyDown.setIntegerValueField(.eventSourceUserData, value: replaySyntheticEventMarker)
            keyUp.setIntegerValueField(.eventSourceUserData, value: replaySyntheticEventMarker)
            keyDown.post(tap: .cghidEventTap)
            keyUp.post(tap: .cghidEventTap)
        }
    }

    private func focusedElementIsSafeForTyping(
        matching expected: AXUIElement?
    ) async throws -> Bool {
        // AX focus propagation can trail a successful focus request briefly.
        // Retry without sending any input, then fail closed if it stays unknown,
        // secure, or focused on a different element.
        for attempt in 0..<40 {
            if MacAccessibility.focusedElementIsSafeForTyping(matching: expected) {
                return true
            }
            guard attempt < 39 else { break }
            try safetyInterlock.check()
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        return false
    }

    public func pressKey(_ command: ActKeyCommand) async throws {
        for _ in 0..<command.repeatCount {
            try safetyInterlock.check()
            try postKey(keyCode: command.keyCode, modifiers: command.modifiers)
        }
    }

    public func scroll(_ command: ActScrollCommand) async throws {
        try safetyInterlock.check()
        if let point = try resolvedPoint(position: command.position, target: command.target) {
            try safetyInterlock.check()
            try postMouseMove(to: point)
        }
        try safetyInterlock.check()
        guard let source = CGEventSource(stateID: .hidSystemState),
              let event = CGEvent(
                scrollWheelEvent2Source: source,
                units: .pixel,
                wheelCount: 2,
                wheel1: clampedInt32(command.deltaY),
                wheel2: clampedInt32(command.deltaX),
                wheel3: 0
              ) else {
            throw SidecarOperationError.captureFailed
        }
        event.setIntegerValueField(.eventSourceUserData, value: replaySyntheticEventMarker)
        event.post(tap: .cghidEventTap)
    }

    public func drag(_ command: ActDragCommand) async throws {
        try safetyInterlock.check()
        let start = CGPoint(x: command.start.x, y: command.start.y)
        let end = CGPoint(x: command.end.x, y: command.end.y)
        try postMouseMove(to: start)

        let eventTypes = mouseEventTypes(for: command.button)
        guard let source = CGEventSource(stateID: .hidSystemState),
              let down = CGEvent(
                mouseEventSource: source,
                mouseType: eventTypes.down,
                mouseCursorPosition: start,
                mouseButton: eventTypes.button
        ) else {
            throw SidecarOperationError.captureFailed
        }
        try safetyInterlock.check()
        down.setIntegerValueField(.eventSourceUserData, value: replaySyntheticEventMarker)
        down.post(tap: .cghidEventTap)

        let stepCount = max(1, min(625, command.durationMs / 16))
        var lastPoint = start
        do {
            for step in 1...stepCount {
                try safetyInterlock.check()
                let fraction = Double(step) / Double(stepCount)
                lastPoint = CGPoint(
                    x: start.x + (end.x - start.x) * fraction,
                    y: start.y + (end.y - start.y) * fraction
                )
                guard let dragged = CGEvent(
                    mouseEventSource: source,
                    mouseType: eventTypes.dragged,
                    mouseCursorPosition: lastPoint,
                    mouseButton: eventTypes.button
                ) else {
                    throw SidecarOperationError.captureFailed
                }
                dragged.setIntegerValueField(.eventSourceUserData, value: replaySyntheticEventMarker)
                dragged.post(tap: .cghidEventTap)
                if command.durationMs > 0 {
                    try await Task.sleep(nanoseconds: UInt64(command.durationMs) * 1_000_000 / UInt64(stepCount))
                }
            }
        } catch {
            try? postMouseUp(at: lastPoint, eventTypes: eventTypes, source: source)
            throw error
        }
        try postMouseUp(at: end, eventTypes: eventTypes, source: source)
    }

    public func navigate(_ command: ActNavigateCommand) async throws {
        guard command.isValidHTTPURL else {
            throw SidecarOperationError.invalidState("Navigation requires an HTTP or HTTPS URL.")
        }
        guard let frontmostBundleId = NSWorkspace.shared.frontmostApplication?.bundleIdentifier else {
            throw SidecarOperationError.targetNotFound
        }
        if let expectedBundleId = command.bundleId {
            guard frontmostBundleId == expectedBundleId else {
                throw SidecarOperationError.targetNotFound
            }
        } else {
            guard Self.knownBrowserBundleIds.contains(frontmostBundleId) else {
                throw SidecarOperationError.targetNotFound
            }
        }

        try safetyInterlock.check()
        try postKey(keyCode: 37, modifiers: [.command]) // Command-L
        try await Task.sleep(nanoseconds: 75_000_000)
        try safetyInterlock.check()
        try await typeText(command.url, target: nil)
        try safetyInterlock.check()
        try postKey(keyCode: 36, modifiers: []) // Return
    }

    private func postClick(
        at point: CGPoint,
        button: MouseButton,
        clickCount: Int
    ) throws {
        let eventTypes = mouseEventTypes(for: button)

        guard let source = CGEventSource(stateID: .hidSystemState),
              let down = CGEvent(
                mouseEventSource: source,
                mouseType: eventTypes.down,
                mouseCursorPosition: point,
                mouseButton: eventTypes.button
              ),
              let up = CGEvent(
                mouseEventSource: source,
                mouseType: eventTypes.up,
                mouseCursorPosition: point,
                mouseButton: eventTypes.button
              ) else {
            throw SidecarOperationError.captureFailed
        }

        for count in 1...clickCount {
            try safetyInterlock.check()
            down.setIntegerValueField(.mouseEventClickState, value: Int64(count))
            up.setIntegerValueField(.mouseEventClickState, value: Int64(count))
            down.setIntegerValueField(.eventSourceUserData, value: replaySyntheticEventMarker)
            up.setIntegerValueField(.eventSourceUserData, value: replaySyntheticEventMarker)
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
        }
    }

    private func postKey(keyCode: UInt16, modifiers: [ModifierKey]) throws {
        guard let source = CGEventSource(stateID: .hidSystemState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(keyCode), keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(keyCode), keyDown: false) else {
            throw SidecarOperationError.captureFailed
        }
        let flags = cgFlags(for: modifiers)
        down.flags = flags
        up.flags = flags
        down.setIntegerValueField(.eventSourceUserData, value: replaySyntheticEventMarker)
        up.setIntegerValueField(.eventSourceUserData, value: replaySyntheticEventMarker)
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }

    private func postMouseMove(to point: CGPoint) throws {
        guard let source = CGEventSource(stateID: .hidSystemState),
              let event = CGEvent(
                mouseEventSource: source,
                mouseType: .mouseMoved,
                mouseCursorPosition: point,
                mouseButton: .left
              ) else {
            throw SidecarOperationError.captureFailed
        }
        event.setIntegerValueField(.eventSourceUserData, value: replaySyntheticEventMarker)
        event.post(tap: .cghidEventTap)
    }

    private typealias MouseEventTypes = (
        button: CGMouseButton,
        down: CGEventType,
        dragged: CGEventType,
        up: CGEventType
    )

    private func mouseEventTypes(for button: MouseButton) -> MouseEventTypes {
        switch button {
        case .left: return (.left, .leftMouseDown, .leftMouseDragged, .leftMouseUp)
        case .right: return (.right, .rightMouseDown, .rightMouseDragged, .rightMouseUp)
        case .other: return (.center, .otherMouseDown, .otherMouseDragged, .otherMouseUp)
        }
    }

    private func postMouseUp(
        at point: CGPoint,
        eventTypes: MouseEventTypes,
        source: CGEventSource
    ) throws {
        guard let event = CGEvent(
            mouseEventSource: source,
            mouseType: eventTypes.up,
            mouseCursorPosition: point,
            mouseButton: eventTypes.button
        ) else {
            throw SidecarOperationError.captureFailed
        }
        event.setIntegerValueField(.eventSourceUserData, value: replaySyntheticEventMarker)
        event.post(tap: .cghidEventTap)
    }

    private func resolvedPoint(
        position: Point?,
        target: ElementSelector?
    ) throws -> CGPoint? {
        if let target {
            if let element = MacAccessibility.resolve(target),
               let center = MacAccessibility.center(of: element) {
                return center
            }
            if position == nil {
                throw SidecarOperationError.targetNotFound
            }
        }
        return position.map { CGPoint(x: $0.x, y: $0.y) }
    }

    private func cgFlags(for modifiers: [ModifierKey]) -> CGEventFlags {
        modifiers.reduce(into: CGEventFlags()) { flags, modifier in
            switch modifier {
            case .command: flags.insert(.maskCommand)
            case .control: flags.insert(.maskControl)
            case .option: flags.insert(.maskAlternate)
            case .shift: flags.insert(.maskShift)
            case .capsLock: flags.insert(.maskAlphaShift)
            case .function: flags.insert(.maskSecondaryFn)
            }
        }
    }

    private func clampedInt32(_ value: Double) -> Int32 {
        guard value.isFinite else { return 0 }
        return Int32(max(Double(Int32.min), min(Double(Int32.max), value.rounded())))
    }

    private static let knownBrowserBundleIds: Set<String> = [
        "com.apple.Safari",
        "com.brave.Browser",
        "com.google.Chrome",
        "com.microsoft.edgemac",
        "com.operasoftware.Opera",
        "com.vivaldi.Vivaldi",
        "company.thebrowser.Browser",
        "org.mozilla.firefox"
    ]
}

func screenshotCoordinateScale(
    imageWidth: Int,
    imageHeight: Int,
    logicalWidth: Double?,
    logicalHeight: Double?,
    fallback: Double
) -> Double {
    guard imageWidth > 0,
          imageHeight > 0,
          let logicalWidth,
          let logicalHeight,
          logicalWidth.isFinite,
          logicalHeight.isFinite,
          logicalWidth > 0,
          logicalHeight > 0 else {
        return fallback.isFinite && fallback > 0 ? fallback : 1
    }
    let horizontal = Double(imageWidth) / logicalWidth
    let vertical = Double(imageHeight) / logicalHeight
    guard horizontal.isFinite,
          vertical.isFinite,
          horizontal > 0,
          vertical > 0,
          abs(horizontal - vertical) / max(horizontal, vertical) <= 0.02 else {
        return fallback.isFinite && fallback > 0 ? fallback : 1
    }
    return (horizontal + vertical) / 2
}
