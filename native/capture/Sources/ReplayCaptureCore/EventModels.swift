import Foundation

public enum Redaction {
    public static let marker = "[REDACTED]"
}

public struct Point: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

public struct Rectangle: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

public struct DisplayInfo: Codable, Equatable, Sendable {
    public var width: Int
    public var height: Int
    public var scale: Double
    public var displayId: UInt32?

    public init(width: Int, height: Int, scale: Double, displayId: UInt32? = nil) {
        self.width = width
        self.height = height
        self.scale = scale
        self.displayId = displayId
    }
}

public enum ModifierKey: String, Codable, CaseIterable, Equatable, Sendable {
    case command
    case control
    case option
    case shift
    case capsLock = "caps_lock"
    case function
}

public enum MouseButton: String, Codable, Equatable, Sendable {
    case left
    case right
    case other
}

public struct KeyEventPayload: Codable, Equatable, Sendable {
    public var keyCode: UInt16
    public var text: String?
    public var modifiers: [ModifierKey]
    public var redacted: Bool

    public init(keyCode: UInt16, text: String?, modifiers: [ModifierKey], redacted: Bool) {
        self.keyCode = keyCode
        self.text = text
        self.modifiers = modifiers
        self.redacted = redacted
    }
}

public struct ScrollEventPayload: Codable, Equatable, Sendable {
    public var deltaX: Double
    public var deltaY: Double

    public init(deltaX: Double, deltaY: Double) {
        self.deltaX = deltaX
        self.deltaY = deltaY
    }
}

public struct DragEventPayload: Codable, Equatable, Sendable {
    public var start: Point
    public var end: Point

    public init(start: Point, end: Point) {
        self.start = start
        self.end = end
    }
}

public struct DOMContext: Codable, Equatable, Sendable {
    public var selector: String?
    public var role: String?
    public var name: String?

    public init(selector: String? = nil, role: String? = nil, name: String? = nil) {
        self.selector = selector
        self.role = role
        self.name = name
    }
}

public struct AccessibilityTarget: Codable, Equatable, Sendable {
    public var role: String?
    public var subrole: String?
    public var label: String?
    public var value: String?
    public var bounds: Rectangle?
    public var bundleId: String?
    public var windowTitle: String?
    public var url: String?
    public var identifier: String?
    public var isSecure: Bool

    public init(
        role: String? = nil,
        subrole: String? = nil,
        label: String? = nil,
        value: String? = nil,
        bounds: Rectangle? = nil,
        bundleId: String? = nil,
        windowTitle: String? = nil,
        url: String? = nil,
        identifier: String? = nil,
        isSecure: Bool = false
    ) {
        self.role = role
        self.subrole = subrole
        self.label = label
        self.value = value
        self.bounds = bounds
        self.bundleId = bundleId
        self.windowTitle = windowTitle
        self.url = url
        self.identifier = identifier
        self.isSecure = isSecure
    }

    public var representsSecureField: Bool {
        isSecure || role == "AXSecureTextField" || subrole == "AXSecureTextField"
    }

    func redactedIfNeeded() -> AccessibilityTarget {
        guard representsSecureField else { return self }
        var copy = self
        copy.isSecure = true
        if copy.value != nil {
            copy.value = Redaction.marker
        }
        return copy
    }
}

public enum CapturedEventType: String, Codable, Equatable, Sendable {
    case click
    case key
    case scroll
    case drag
    case appSwitch = "app_switch"
    case windowSwitch = "window_switch"
}

/// The only input-event representation that can be encoded to disk. Instances
/// are produced by `EventSanitizer`, never directly by an OS event callback.
public struct CapturedEvent: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let id: String
    public let sessionId: String
    public let timestampMs: Double
    public let type: CapturedEventType
    public let position: Point?
    public let button: MouseButton?
    public let clickCount: Int?
    public let key: KeyEventPayload?
    public let scroll: ScrollEventPayload?
    public let drag: DragEventPayload?
    public let target: AccessibilityTarget?
    public let dom: DOMContext?

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case id
        case sessionId
        case timestampMs
        case type
        case position
        case button
        case clickCount
        case key
        case scroll
        case drag
        case target
        case dom
    }

    init(
        id: String,
        sessionId: String,
        timestampMs: Double,
        type: CapturedEventType,
        position: Point? = nil,
        button: MouseButton? = nil,
        clickCount: Int? = nil,
        key: KeyEventPayload? = nil,
        scroll: ScrollEventPayload? = nil,
        drag: DragEventPayload? = nil,
        target: AccessibilityTarget? = nil,
        dom: DOMContext? = nil
    ) {
        self.schemaVersion = 1
        self.id = id
        self.sessionId = sessionId
        self.timestampMs = timestampMs
        self.type = type
        self.position = position
        self.button = button
        self.clickCount = clickCount
        self.key = key
        self.scroll = scroll
        self.drag = drag
        self.target = target
        self.dom = dom
    }

    /// Encoding is itself a privacy boundary. This protects callers that
    /// accidentally encode a value constructed inside this module without
    /// first passing it through the sanitizer or session writer.
    public func encode(to encoder: Encoder) throws {
        let secureTarget = target?.representsSecureField == true
        let shouldRedactKey = type == .key
            && (secureTarget || target?.role == nil)
        let safeKey: KeyEventPayload?
        if shouldRedactKey, let key {
            safeKey = KeyEventPayload(
                keyCode: key.keyCode,
                text: Redaction.marker,
                modifiers: key.modifiers,
                redacted: true
            )
        } else {
            safeKey = key
        }

        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(id, forKey: .id)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(timestampMs, forKey: .timestampMs)
        try container.encode(type, forKey: .type)
        try container.encodeIfPresent(position, forKey: .position)
        try container.encodeIfPresent(button, forKey: .button)
        try container.encodeIfPresent(clickCount, forKey: .clickCount)
        try container.encodeIfPresent(safeKey, forKey: .key)
        try container.encodeIfPresent(scroll, forKey: .scroll)
        try container.encodeIfPresent(drag, forKey: .drag)
        try container.encodeIfPresent(target?.redactedIfNeeded(), forKey: .target)
        if !secureTarget && !shouldRedactKey {
            try container.encodeIfPresent(dom, forKey: .dom)
        }
    }
}

/// A deliberately non-Codable boundary type. Sensitive key text can exist here
/// briefly in memory, but cannot be handed to JSONEncoder by mistake.
public enum RawInputEvent: Equatable, Sendable {
    case click(
        id: String,
        sessionId: String,
        timestampMs: Double,
        position: Point,
        button: MouseButton,
        clickCount: Int
    )
    case key(
        id: String,
        sessionId: String,
        timestampMs: Double,
        keyCode: UInt16,
        text: String?,
        modifiers: [ModifierKey]
    )
    case scroll(
        id: String,
        sessionId: String,
        timestampMs: Double,
        position: Point,
        deltaX: Double,
        deltaY: Double
    )
    case drag(
        id: String,
        sessionId: String,
        timestampMs: Double,
        start: Point,
        end: Point,
        button: MouseButton
    )
    case appSwitch(
        id: String,
        sessionId: String,
        timestampMs: Double
    )
    case windowSwitch(
        id: String,
        sessionId: String,
        timestampMs: Double
    )
}

public enum EventSanitizer {
    public static func sanitize(
        _ raw: RawInputEvent,
        target: AccessibilityTarget?,
        dom: DOMContext? = nil
    ) -> CapturedEvent {
        let secure = target?.representsSecureField == true
        let safeTarget = target?.redactedIfNeeded()
        // A future browser extension may put field-adjacent details in this
        // reserved slot. Treat all of it as sensitive when AX says the target
        // is secure instead of trying to guess which DOM values are safe.
        let safeDOM = secure ? nil : dom

        switch raw {
        case let .click(id, sessionId, timestampMs, position, button, clickCount):
            return CapturedEvent(
                id: id,
                sessionId: sessionId,
                timestampMs: timestampMs,
                type: .click,
                position: position,
                button: button,
                clickCount: clickCount,
                target: safeTarget,
                dom: safeDOM
            )
        case let .key(id, sessionId, timestampMs, keyCode, text, modifiers):
            // If Accessibility cannot identify the focused element, privacy
            // wins over capture fidelity. A transient AX failure must never be
            // the reason a password reaches disk.
            let shouldRedact = secure || target?.role == nil
            return CapturedEvent(
                id: id,
                sessionId: sessionId,
                timestampMs: timestampMs,
                type: .key,
                key: KeyEventPayload(
                    keyCode: keyCode,
                    text: shouldRedact ? Redaction.marker : text,
                    modifiers: modifiers,
                    redacted: shouldRedact
                ),
                target: safeTarget,
                dom: shouldRedact ? nil : safeDOM
            )
        case let .scroll(id, sessionId, timestampMs, position, deltaX, deltaY):
            return CapturedEvent(
                id: id,
                sessionId: sessionId,
                timestampMs: timestampMs,
                type: .scroll,
                position: position,
                scroll: ScrollEventPayload(deltaX: deltaX, deltaY: deltaY),
                target: safeTarget,
                dom: safeDOM
            )
        case let .drag(id, sessionId, timestampMs, start, end, button):
            return CapturedEvent(
                id: id,
                sessionId: sessionId,
                timestampMs: timestampMs,
                type: .drag,
                button: button,
                drag: DragEventPayload(start: start, end: end),
                target: safeTarget,
                dom: safeDOM
            )
        case let .appSwitch(id, sessionId, timestampMs):
            return CapturedEvent(
                id: id,
                sessionId: sessionId,
                timestampMs: timestampMs,
                type: .appSwitch,
                target: safeTarget,
                dom: safeDOM
            )
        case let .windowSwitch(id, sessionId, timestampMs):
            return CapturedEvent(
                id: id,
                sessionId: sessionId,
                timestampMs: timestampMs,
                type: .windowSwitch,
                target: safeTarget,
                dom: safeDOM
            )
        }
    }
}

extension CapturedEvent {
    /// A second redaction boundary at the file writer protects against an
    /// unsafe event decoded from external JSON or constructed in a future code
    /// path that bypasses `EventSanitizer`.
    func safeForPersistence() -> CapturedEvent {
        let secureTarget = target?.representsSecureField == true
        let shouldRedactKey = type == .key
            && (secureTarget || target?.role == nil)
        let safeKey: KeyEventPayload?
        if shouldRedactKey, let key {
            safeKey = KeyEventPayload(
                keyCode: key.keyCode,
                text: Redaction.marker,
                modifiers: key.modifiers,
                redacted: true
            )
        } else {
            safeKey = key
        }
        return CapturedEvent(
            id: id,
            sessionId: sessionId,
            timestampMs: timestampMs,
            type: type,
            position: position,
            button: button,
            clickCount: clickCount,
            key: safeKey,
            scroll: scroll,
            drag: drag,
            target: target?.redactedIfNeeded(),
            dom: secureTarget || shouldRedactKey ? nil : dom
        )
    }
}
